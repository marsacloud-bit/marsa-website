-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261105000100 — G5: Daftra integration & invoicing
-- (docs/online/G5_SPEC.md). Builds on G4 (20261104000100).
--
-- Prepares Daftra invoice DRAFTS from approved G4 client charges and pulls their status
-- back, with no duplicate invoice, no duplicate line and no blind overwrite:
--   1. daftra_connections      one per org: mode (mock | live_pending), status, capabilities,
--                              tax settings. NO SECRET IS STORED ANYWHERE (Vault / Edge secrets later).
--   2. capability probe        a 'probe' job; completion writes the capability record.
--   3. daftra_client_links     clients ↔ Daftra clients (unique per org, drift shown, never overwritten).
--   4. daftra_item_links       '<kind>:<service_code|none>' ↔ Daftra product (unique both ways).
--   5. billing_intents         invoice intent per transaction + currency + purpose; fixed operational_ref.
--   6. billing_intent_lines    one live line per charge (unique), snapshot, unique line_ref.
--   7. billing_sync_jobs       outbox; one running job per org; retry / unknown / conflict policy.
--   8. billing_sync_attempts   append-only request / response log (redacted).
--   9-11. read-before-update conflicts, frozen issued invoices, billing_review_items.
--   12. tax policy (allowed rates; no blocking operational link).
--   13. status pull + scheduler.  14. daftra_mock_accounts (service role only).
-- Staff RPCs: authenticated. Worker RPCs (daftra_*): service_role only.
-- Clients see nothing from G5 (no SELECT policy, no RPC result).
-- Events: transaction_events 'billing' (internal; payload {op, entity, id, …ids}, never amounts).
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS); preflight first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261104000100') THEN
    RAISE EXCEPTION 'G5 preflight: apply G4 first (schema_versions lacks 20261104000100 g4_costs)';
  END IF;
  -- G4 reserved 'invoiced' for G5: no row may carry it before G5 exists (skipped on a re-run)
  IF NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261105000100')
     AND EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status = 'invoiced') THEN
    RAISE EXCEPTION 'G5 preflight: client_charges already invoiced outside G5';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261105000100', 'g5_daftra')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('daftra_mode','mock',1,'محاكاة تجريبية','Mock (simulation)',false),
  ('daftra_mode','live_pending',2,'حساب حقيقي — غير مُعدّ','Live account — not configured',false),
  ('daftra_conn_status','not_connected',1,'غير متصل','Not connected',false),
  ('daftra_conn_status','connected',2,'متصل','Connected',false),
  ('daftra_conn_status','error',3,'خطأ','Error',false),
  ('daftra_conn_status','disabled',4,'موقوف','Disabled',false),
  ('daftra_link_status','pending',1,'بانتظار المزامنة','Pending sync',false),
  ('daftra_link_status','linked',2,'مربوط','Linked',false),
  ('daftra_link_status','drift',3,'اختلاف بيانات','Data drift',false),
  ('daftra_link_status','needs_review',4,'يحتاج مراجعة','Needs review',false),
  ('daftra_link_status','error',5,'خطأ','Error',false),
  ('daftra_link_status','unlinked',6,'مفكوك','Unlinked',false),
  ('daftra_tax_code','standard',1,'خاضع للنسبة الأساسية','Standard rate',false),
  ('daftra_tax_code','zero',2,'نسبة صفرية','Zero rated',false),
  ('daftra_tax_code','exempt',3,'معفى','Exempt',false),
  ('daftra_tax_code','out_of_scope',4,'خارج النطاق (مبلغ مسترد)','Out of scope (disbursement)',false),
  ('daftra_capability','clients.search_by_ref',1,'البحث عن العميل بالمرجع','Find client by reference',false),
  ('daftra_capability','clients.read',2,'قراءة العميل','Read client',false),
  ('daftra_capability','clients.create',3,'إنشاء عميل','Create client',false),
  ('daftra_capability','clients.update',4,'تحديث عميل','Update client',false),
  ('daftra_capability','products.search_by_code',5,'البحث عن الصنف بالرمز','Find product by code',false),
  ('daftra_capability','products.search_by_name',6,'البحث عن الصنف بالاسم','Find product by name',false),
  ('daftra_capability','products.create',7,'إنشاء صنف','Create product',false),
  ('daftra_capability','invoices.create_draft',8,'إنشاء مسودة فاتورة','Create invoice draft',false),
  ('daftra_capability','invoices.read',9,'قراءة الفاتورة','Read invoice',false),
  ('daftra_capability','invoices.search_by_reference',10,'البحث عن الفاتورة بالمرجع التشغيلي','Find invoice by reference',false),
  ('daftra_capability','invoices.update_draft',11,'تحديث مسودة','Update draft',false),
  ('daftra_capability','invoices.line_reference_field',12,'حقل مرجع للبند','Line reference field',false),
  ('daftra_capability','invoices.version_token',13,'رمز إصدار الفاتورة','Invoice version token',false),
  ('daftra_capability','invoices.multi_currency',14,'تعدد العملات','Multi-currency',false),
  ('daftra_capability','invoices.issue',15,'إصدار الفاتورة (لا يُستخدم)','Issue invoice (never used)',false),
  ('daftra_capability','payments.read',16,'قراءة المدفوعات','Read payments',false),
  ('daftra_capability','credit_notes.create',17,'إنشاء إشعار دائن (لا يُستخدم)','Create credit note (never used)',false),
  ('bill_purpose','final',1,'فاتورة نهائية','Final invoice',false),
  ('bill_purpose','interim',2,'فاتورة مرحلية','Interim invoice',false),
  ('bill_purpose','supplementary',3,'فاتورة إضافية','Supplementary invoice',false),
  ('bill_intent_status','open',1,'قيد الإعداد','Open',false),
  ('bill_intent_status','draft',2,'مسودة في دفترة','Draft in Daftra',false),
  ('bill_intent_status','issued',3,'صادرة','Issued',false),
  ('bill_intent_status','cancelled',4,'ملغاة','Cancelled',false),
  ('bill_sync_state','idle',1,'لم تُرسل','Not sent',false),
  ('bill_sync_state','pending',2,'تغييرات بانتظار الإرسال','Changes pending',false),
  ('bill_sync_state','in_flight',3,'قيد الإرسال','Sending',false),
  ('bill_sync_state','synced',4,'متزامنة','Synced',false),
  ('bill_sync_state','unknown',5,'نتيجة غير معروفة','Unknown result',false),
  ('bill_sync_state','conflict',6,'تعارض','Conflict',false),
  ('bill_sync_state','error',7,'خطأ','Error',false),
  ('bill_line_state','pending_add',1,'بانتظار الإضافة','Pending add',false),
  ('bill_line_state','synced',2,'في المسودة','In the draft',false),
  ('bill_line_state','pending_remove',3,'بانتظار الحذف','Pending removal',false),
  ('bill_line_state','removed',4,'محذوف','Removed',false),
  ('bill_job_kind','probe',1,'فحص الإمكانات','Capability probe',false),
  ('bill_job_kind','client_ensure',2,'ربط العميل','Ensure client',false),
  ('bill_job_kind','client_refresh',3,'تحديث بيانات العميل من دفترة','Refresh client',false),
  ('bill_job_kind','client_push',4,'إرسال بيانات العميل إلى دفترة','Push client data',false),
  ('bill_job_kind','item_ensure',5,'ربط الصنف','Ensure product',false),
  ('bill_job_kind','invoice_push',6,'إرسال الفاتورة','Push invoice',false),
  ('bill_job_kind','invoice_pull',7,'تحديث حالة الفاتورة','Pull invoice status',false),
  ('bill_job_status','queued',1,'في الانتظار','Queued',false),
  ('bill_job_status','running',2,'قيد التنفيذ','Running',false),
  ('bill_job_status','unknown',3,'بانتظار المطابقة','Awaiting reconciliation',false),
  ('bill_job_status','done',4,'تمت','Done',false),
  ('bill_job_status','conflict',5,'تعارض','Conflict',false),
  ('bill_job_status','failed',6,'فشلت','Failed',false),
  ('bill_job_status','dead',7,'استنفدت المحاولات','Attempts exhausted',false),
  ('bill_job_status','cancelled',8,'أُلغيت','Cancelled',false),
  ('bill_review_kind','late_charge',1,'مبلغ لاحق بعد الإصدار','Late charge after issue',false),
  ('bill_review_kind','issued_mismatch',2,'الفاتورة الصادرة تختلف','Issued invoice differs',false),
  ('bill_review_kind','issued_cancelled',3,'أُلغيت الفاتورة في دفترة','Cancelled in Daftra',false),
  ('bill_review_status','open',1,'مفتوح','Open',false),
  ('bill_review_status','resolved',2,'تمت المعالجة','Resolved',false),
  ('bill_review_status','dismissed',3,'مستبعد','Dismissed',false),
  ('daftra_payment_status','unknown',1,'غير معروف','Unknown',false),
  ('daftra_payment_status','unpaid',2,'غير مسددة','Unpaid',false),
  ('daftra_payment_status','partial',3,'مسددة جزئيًا','Partially paid',false),
  ('daftra_payment_status','paid',4,'مسددة','Paid',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- billing events (internal, never amounts): superset of the G4 list
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
   'billing'));

-- ---------------------------------------------------------------------
-- roles + pure helpers
-- ---------------------------------------------------------------------
-- connection, probe, item / tax catalog, unlink a client (org-level)
CREATE OR REPLACE FUNCTION app.bill_admin_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accounts_manager','admin']
$$;

-- capability keys (fixed list; = daftra_capability domain) and the push gate subset
CREATE OR REPLACE FUNCTION app.bill_capability_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clients.search_by_ref','clients.read','clients.create','clients.update','products.search_by_code',
               'products.search_by_name','products.create','invoices.create_draft','invoices.read','invoices.search_by_reference',
               'invoices.update_draft','invoices.line_reference_field','invoices.version_token','invoices.multi_currency',
               'invoices.issue','payments.read','credit_notes.create']
$$;
CREATE OR REPLACE FUNCTION app.bill_required_caps() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoices.create_draft','invoices.read','invoices.search_by_reference','invoices.update_draft',
               'clients.search_by_ref','clients.create','products.search_by_code','products.create']
$$;

-- a secret-like key name (dropped from every logged object; the value of a [name, value] header pair is masked)
CREATE OR REPLACE FUNCTION app.bill_secret_key(k text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(k ~* '(api[_-]?key|secret|token|password|passwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)'
                  OR k ~* '^[[:space:]]*(pass|pwd|auth|bearer|x-auth)[[:space:]]*$', false)
$$;

-- secrets inside a free text (URL query strings, "name=value" / "name: value" pairs, bearer / basic credentials)
--   are replaced by [redacted]; mirrored by scrubText() in supabase/functions/daftra-sync/worker.js
CREATE OR REPLACE FUNCTION app.bill_scrub_text(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE
    regexp_replace(
      regexp_replace(
        regexp_replace(p, '(https?://[^[:space:]?#"'']+)[?][^[:space:]#"'']*', '\1?[redacted]', 'gi'),
        '(bearer|basic)[[:space:]]+[^[:space:]"'',;]+', '\1 [redacted]', 'gi'),
      '([A-Za-z0-9_.-]*(api[_-]?key|secret|token|password|passwd|pwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)[A-Za-z0-9_.-]*)([[:space:]]*[=:][[:space:]]*"?)[^[:space:]&"'',;]+',
      '\1\3[redacted]', 'gi') END
$$;

-- logged request / response bodies: drop secret-like keys at any depth, mask [name, value] header pairs,
-- scrub secrets inside string values, cap long strings
CREATE OR REPLACE FUNCTION app.bill_redact(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r jsonb; k text; v jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(p)
    WHEN 'object' THEN
      r := '{}'::jsonb;
      FOR k, v IN SELECT e.key, e.value FROM jsonb_each(p) e LOOP
        CONTINUE WHEN app.bill_secret_key(k);
        r := r || jsonb_build_object(k, app.bill_redact(v));
      END LOOP;
      RETURN r;
    WHEN 'array' THEN
      IF jsonb_array_length(p) = 2 AND jsonb_typeof(p -> 0) = 'string' AND app.bill_secret_key(p ->> 0) THEN
        RETURN jsonb_build_array(p -> 0, '[redacted]');                 -- a header pair ['APIKEY', '…']
      END IF;
      RETURN coalesce((SELECT jsonb_agg(app.bill_redact(x.e) ORDER BY x.o) FROM jsonb_array_elements(p) WITH ORDINALITY x(e, o)), '[]'::jsonb);
    WHEN 'string' THEN
      RETURN to_jsonb(left(app.bill_scrub_text(p #>> '{}'), 4000));
    ELSE RETURN p;
  END CASE;
END $$;

-- worker RPCs only (auth.role() = service_role)
CREATE OR REPLACE FUNCTION app.bill_service_only() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
END $$;

-- item key '<kind>:<service_code|none>' (shape only; the code is checked against fin_service by the RPCs)
CREATE OR REPLACE FUNCTION app.bill_item_key(p_kind text, p_service_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_kind || ':' || coalesce(p_service_code, 'none')
$$;
CREATE OR REPLACE FUNCTION app.bill_check_item_key(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NOT NULL AND p ~ '^(service|internal_service|reimbursable):[a-z][a-z0-9_]{0,39}$'
$$;
CREATE OR REPLACE FUNCTION app.bill_valid_item_key(p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.bill_check_item_key(p)
     AND (split_part(p, ':', 2) = 'none' OR app.is_code('fin_service', split_part(p, ':', 2)))
$$;

-- Daftra-side ids / hashes in worker results
CREATE OR REPLACE FUNCTION app.bill_ext_id(p text, p_field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF p !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN PERFORM app.fail('MRS_INVALID', p_field); END IF;
  RETURN p;
END $$;
CREATE OR REPLACE FUNCTION app.bill_hash(p text, p_field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF p !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', p_field); END IF;
  RETURN p;
END $$;
-- bounded text from a worker result (NULL when absent; MRS_INVALID when not a scalar)
CREATE OR REPLACE FUNCTION app.bill_rtext(p jsonb, k text, p_max int) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p -> k) IS NULL OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  v := nullif(btrim(p ->> k), '');
  IF char_length(v) > p_max THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION app.bill_ts(p jsonb, k text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE s text := app.bill_rtext(p, k, 40);
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  BEGIN RETURN s::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', k); END;
  RETURN NULL;
END $$;

-- client snapshot (the data Marsa would send; trimmed, empty → null)
CREATE OR REPLACE FUNCTION app.bill_client_snapshot(c public.clients) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'name', nullif(btrim(c.name_ar), ''),
    'name_en', nullif(btrim(coalesce(c.name_en, '')), ''),
    'vat_number', nullif(btrim(coalesce(c.vat_number, '')), ''),
    'cr_number', nullif(btrim(coalesce(c.cr_number, '')), ''),
    'address_short', nullif(btrim(coalesce(c.national_address_short, '')), ''),
    'address', nullif(btrim(concat_ws(', ',
        nullif(btrim(concat_ws(' ', nullif(btrim(c.national_address ->> 'building_no'), ''), nullif(btrim(c.national_address ->> 'street'), ''))), ''),
        nullif(btrim(c.national_address ->> 'district'), ''),
        nullif(btrim(concat_ws(' ', nullif(btrim(c.national_address ->> 'city'), ''), nullif(btrim(c.national_address ->> 'postal_code'), ''))), ''),
        nullif(btrim(c.national_address ->> 'additional_no'), ''),
        nullif(btrim(c.national_address ->> 'unit_no'), ''))), ''),
    'email', nullif(btrim(coalesce(c.email, '')), ''),
    'phone', nullif(btrim(coalesce(c.phone, '')), ''))
$$;
CREATE OR REPLACE FUNCTION app.bill_snapshot_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['name','name_en','vat_number','cr_number','address_short','address','email','phone']
$$;
-- a snapshot from a worker result: only the 8 keys, scalar text ≤ 300, empty → null
CREATE OR REPLACE FUNCTION app.bill_snap_norm(p jsonb, p_field text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r jsonb := '{}'::jsonb; k text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', p_field); END IF;
  FOREACH k IN ARRAY app.bill_snapshot_keys() LOOP
    IF jsonb_typeof(p -> k) IN ('object','array') OR char_length(p ->> k) > 300 THEN PERFORM app.fail('MRS_INVALID', p_field); END IF;
    r := r || jsonb_build_object(k, nullif(btrim(coalesce(p ->> k, '')), ''));
  END LOOP;
  RETURN r;
END $$;

-- ---------------------------------------------------------------------
-- 1. daftra_connections — one per org; status / mode / capabilities / tax settings only (NO secret)
--    A future live key lives in Supabase Vault ('daftra_api_key:<org_id>') or Edge Function secrets,
--    read only by the server-side worker. No table readable by staff or clients ever holds it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daftra_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  mode                     text NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock','live_pending')),
  status                   text NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected','connected','error','disabled')),
  subdomain                text CHECK (subdomain ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),   -- placeholder, never called in G5
  sync_enabled             boolean NOT NULL DEFAULT false,
  capabilities             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  capabilities_checked_at  timestamptz,
  capabilities_source      text CHECK (capabilities_source IN ('mock','live')),
  last_check_at            timestamptz,
  last_check_status        text CHECK (last_check_status IN ('ok','failed')),
  last_error_code          text CHECK (char_length(last_error_code) <= 60),
  last_error_message       text CHECK (char_length(last_error_message) <= 500),
  default_service_vat_rate numeric(5,2) NOT NULL DEFAULT 15 CHECK (default_service_vat_rate BETWEEN 0 AND 100),
  allowed_vat_rates        numeric(5,2)[] NOT NULL DEFAULT '{0,15}' CHECK (cardinality(allowed_vat_rates) BETWEEN 1 AND 10),
  reimbursable_tax_code    text NOT NULL DEFAULT 'out_of_scope' CHECK (reimbursable_tax_code IN ('standard','zero','exempt','out_of_scope')),
  invoice_notes            text CHECK (char_length(invoice_notes) <= 500),
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daftra_connections_org_uniq UNIQUE (org_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_connections IS 'G5 per-org Daftra connection: mode, status, capabilities, tax settings. Holds NO secret (live key: Vault / Edge secrets, worker only).';
-- one Daftra account (subdomain) belongs to one org only: two orgs behind one account would mix their invoices
-- (references and product codes are numbered per org). Re-runnable; stops loudly if a duplicate already exists.
DO $sub$
BEGIN
  IF to_regclass('public.daftra_connections_subdomain_uidx') IS NULL
     AND EXISTS (SELECT 1 FROM public.daftra_connections c WHERE c.subdomain IS NOT NULL GROUP BY lower(c.subdomain) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'G5: two organisations use the same Daftra subdomain (daftra_connections.subdomain); clear one, then re-run';
  END IF;
END $sub$;
CREATE UNIQUE INDEX IF NOT EXISTS daftra_connections_subdomain_uidx ON public.daftra_connections (lower(subdomain)) WHERE subdomain IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. daftra_client_links
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daftra_client_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id          uuid NOT NULL,
  client_ref         text NOT NULL CHECK (client_ref ~ '^MRSC-[0-9a-f-]{36}$'),
  external_id        text CHECK (external_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','drift','needs_review','error','unlinked')),
  pushed_snapshot    jsonb CHECK (pushed_snapshot IS NULL OR jsonb_typeof(pushed_snapshot) = 'object'),
  remote_snapshot    jsonb CHECK (remote_snapshot IS NULL OR jsonb_typeof(remote_snapshot) = 'object'),
  drift              text[] NOT NULL DEFAULT '{}',
  drift_detected_at  timestamptz,
  candidates         jsonb CHECK (candidates IS NULL OR (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 10)),
  last_synced_at     timestamptz,
  last_error_code    text CHECK (char_length(last_error_code) <= 60),
  last_error_message text CHECK (char_length(last_error_message) <= 500),
  linked_by          uuid,
  linked_at          timestamptz,
  unlinked_by        uuid,
  unlinked_at        timestamptz,
  unlink_reason      text CHECK (char_length(unlink_reason) <= 2000),
  review_note        text CHECK (char_length(review_note) <= 2000),
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daftra_client_links_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT daftra_client_links_unlink_chk CHECK (status <> 'unlinked' OR (unlinked_at IS NOT NULL AND unlink_reason IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_client_links IS 'G5 Marsa client ↔ Daftra client (one live link each way per org). Drift is shown, never auto-overwritten.';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_client_links_client_uidx ON public.daftra_client_links (org_id, client_id) WHERE status <> 'unlinked';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_client_links_external_uidx ON public.daftra_client_links (org_id, external_id)
  WHERE external_id IS NOT NULL AND status <> 'unlinked';

-- ---------------------------------------------------------------------
-- 4. daftra_item_links
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daftra_item_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  item_key            text NOT NULL CHECK (app.bill_check_item_key(item_key)),
  product_code        text NOT NULL CHECK (product_code ~ '^MRS-[a-z_]+-[a-z0-9_]+$'),
  name_ar             text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 160),
  name_en             text CHECK (char_length(name_en) <= 160),
  default_vat_rate    numeric(5,2) NOT NULL CHECK (default_vat_rate BETWEEN 0 AND 100),
  tax_code            text NOT NULL CHECK (tax_code IN ('standard','zero','exempt','out_of_scope')),
  external_product_id text CHECK (external_product_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','needs_review','error','retired')),
  candidates          jsonb CHECK (candidates IS NULL OR (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 10)),
  last_synced_at      timestamptz,
  last_error_code     text CHECK (char_length(last_error_code) <= 60),
  last_error_message  text CHECK (char_length(last_error_message) <= 500),
  updated_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_item_links IS 'G5 item key (<kind>:<service_code|none>) ↔ Daftra product; one each way per org.';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_item_links_key_uidx ON public.daftra_item_links (org_id, item_key) WHERE status <> 'retired';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_item_links_external_uidx ON public.daftra_item_links (org_id, external_product_id)
  WHERE external_product_id IS NOT NULL AND status <> 'retired';

-- ---------------------------------------------------------------------
-- 5. billing_intents — invoice intent «غرض الفوترة»
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_intents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  transaction_id      uuid NOT NULL,
  client_id           uuid NOT NULL,
  purpose             text NOT NULL DEFAULT 'final' CHECK (purpose IN ('final','interim','supplementary')),
  purpose_key         text NOT NULL CHECK (purpose_key ~ '^(F|I[1-9][0-9]{0,2}|S[1-9][0-9]{0,2})$'),
  currency            char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  revision            int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  operational_ref     text NOT NULL CHECK (char_length(operational_ref) BETWEEN 3 AND 60),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','draft','issued','cancelled')),
  sync_state          text NOT NULL DEFAULT 'idle' CHECK (sync_state IN ('idle','pending','in_flight','synced','unknown','conflict','error')),
  external_invoice_id text CHECK (external_invoice_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  daftra_number       text CHECK (char_length(daftra_number) <= 60),
  daftra_status       text CHECK (char_length(daftra_status) <= 40),
  remote_version      text CHECK (char_length(remote_version) <= 64),
  pushed_hash         text CHECK (pushed_hash ~ '^[0-9a-f]{64}$'),
  remote_hash         text CHECK (remote_hash ~ '^[0-9a-f]{64}$'),
  pushed_at           timestamptz,
  last_pulled_at      timestamptz,
  last_synced_at      timestamptz,
  remote_net          numeric(14,2) CHECK (remote_net >= 0),
  remote_vat          numeric(14,2) CHECK (remote_vat >= 0),
  remote_total        numeric(14,2) CHECK (remote_total >= 0),
  payment_status      text NOT NULL DEFAULT 'unknown' CHECK (payment_status IN ('unknown','unpaid','partial','paid')),
  paid_amount         numeric(14,2) CHECK (paid_amount >= 0),
  last_payment_at     timestamptz,
  lines_net           numeric(14,2) NOT NULL DEFAULT 0 CHECK (lines_net >= 0),
  lines_vat           numeric(14,2) NOT NULL DEFAULT 0 CHECK (lines_vat >= 0),
  lines_total         numeric(14,2) NOT NULL DEFAULT 0 CHECK (lines_total >= 0),
  conflict            jsonb CHECK (conflict IS NULL OR jsonb_typeof(conflict) = 'object'),
  last_error_code     text CHECK (char_length(last_error_code) <= 60),
  last_error_message  text CHECK (char_length(last_error_message) <= 500),
  issued_at           timestamptz,
  cancelled_by        uuid,
  cancelled_at        timestamptz,
  cancel_reason       text CHECK (char_length(cancel_reason) <= 2000),
  note                text CHECK (char_length(note) <= 2000),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_intents_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT billing_intents_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT billing_intents_ref_uniq UNIQUE (org_id, operational_ref),
  CONSTRAINT billing_intents_cancel_chk CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CONSTRAINT billing_intents_purpose_chk CHECK (left(purpose_key, 1) = CASE purpose WHEN 'final' THEN 'F' WHEN 'interim' THEN 'I' ELSE 'S' END),
  UNIQUE (id, org_id),
  UNIQUE (id, transaction_id)
);
COMMENT ON TABLE public.billing_intents IS 'G5 invoice intent per transaction + currency + purpose. operational_ref is the fixed reference sent to Daftra (never reused). Daftra is the source of truth for the official document.';
CREATE UNIQUE INDEX IF NOT EXISTS billing_intents_purpose_uidx ON public.billing_intents (transaction_id, currency, purpose_key) WHERE status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS billing_intents_external_uidx ON public.billing_intents (org_id, external_invoice_id) WHERE external_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_intents_tx_idx ON public.billing_intents (transaction_id);
CREATE INDEX IF NOT EXISTS billing_intents_org_idx ON public.billing_intents (org_id, status, sync_state);

-- ---------------------------------------------------------------------
-- 6. billing_intent_lines
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_intent_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  transaction_id  uuid NOT NULL,
  intent_id       uuid NOT NULL,
  charge_id       uuid NOT NULL,
  line_ref        text NOT NULL CHECK (line_ref ~ '^MRSL-[0-9A-F]{16}$'),
  item_key        text NOT NULL CHECK (app.bill_check_item_key(item_key)),
  description     text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  net_amount      numeric(14,2) NOT NULL CHECK (net_amount >= 0),
  vat_rate        numeric(5,2) NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),
  vat_amount      numeric(14,2) NOT NULL CHECK (vat_amount >= 0),
  total_amount    numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind            text NOT NULL CHECK (kind IN ('service','internal_service','reimbursable')),
  service_code    text,
  state           text NOT NULL DEFAULT 'pending_add' CHECK (state IN ('pending_add','synced','pending_remove','removed')),
  pushed          boolean NOT NULL DEFAULT false,
  remote_line_id  text CHECK (remote_line_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  remote_override jsonb CHECK (remote_override IS NULL OR jsonb_typeof(remote_override) = 'object'),
  removed_reason  text CHECK (char_length(removed_reason) <= 2000),
  removed_by      uuid,
  removed_at      timestamptz,
  added_by        uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_intent_lines_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT billing_intent_lines_intent_fk FOREIGN KEY (intent_id, transaction_id) REFERENCES public.billing_intents(id, transaction_id),
  CONSTRAINT billing_intent_lines_charge_fk FOREIGN KEY (charge_id, transaction_id) REFERENCES public.client_charges(id, transaction_id),
  CONSTRAINT billing_intent_lines_ref_uniq UNIQUE (org_id, line_ref),
  CONSTRAINT billing_intent_lines_removed_chk CHECK (state <> 'removed' OR (removed_at IS NOT NULL AND removed_reason IS NOT NULL)),
  CONSTRAINT billing_intent_lines_total_chk CHECK (total_amount = net_amount + vat_amount),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.billing_intent_lines IS 'G5 invoice-intent line: snapshot of one approved client charge with a unique line_ref. A charge sits on at most one live line.';
-- no double billing: one live line per charge, across all intents
CREATE UNIQUE INDEX IF NOT EXISTS billing_intent_lines_charge_uidx ON public.billing_intent_lines (charge_id) WHERE state <> 'removed';
CREATE INDEX IF NOT EXISTS billing_intent_lines_intent_idx ON public.billing_intent_lines (intent_id, state);

-- ---------------------------------------------------------------------
-- 7. billing_sync_jobs — outbox
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_sync_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('probe','client_ensure','client_refresh','client_push','item_ensure','invoice_push','invoice_pull')),
  intent_id          uuid,
  client_link_id     uuid,
  item_link_id       uuid,
  dedupe_key         text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 5 AND 120),
  options            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','unknown','done','conflict','failed','dead','cancelled')),
  priority           int NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 9),
  attempts           int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 1000),
  next_run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by          text CHECK (char_length(locked_by) <= 80),
  locked_until       timestamptz,
  expected_hash      text CHECK (expected_hash ~ '^[0-9a-f]{64}$'),
  last_error_kind    text CHECK (char_length(last_error_kind) <= 60),
  last_error_code    text CHECK (char_length(last_error_code) <= 60),
  last_error_message text CHECK (char_length(last_error_message) <= 500),
  requested_by       uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_sync_jobs_intent_fk FOREIGN KEY (intent_id, org_id) REFERENCES public.billing_intents(id, org_id),
  CONSTRAINT billing_sync_jobs_client_fk FOREIGN KEY (client_link_id, org_id) REFERENCES public.daftra_client_links(id, org_id),
  CONSTRAINT billing_sync_jobs_item_fk FOREIGN KEY (item_link_id, org_id) REFERENCES public.daftra_item_links(id, org_id),
  CONSTRAINT billing_sync_jobs_target_chk CHECK (CASE
    WHEN kind IN ('invoice_push','invoice_pull') THEN intent_id IS NOT NULL AND client_link_id IS NULL AND item_link_id IS NULL
    WHEN kind IN ('client_ensure','client_refresh','client_push') THEN client_link_id IS NOT NULL AND intent_id IS NULL AND item_link_id IS NULL
    WHEN kind = 'item_ensure' THEN item_link_id IS NOT NULL AND intent_id IS NULL AND client_link_id IS NULL
    ELSE intent_id IS NULL AND client_link_id IS NULL AND item_link_id IS NULL END),
  CONSTRAINT billing_sync_jobs_lock_chk CHECK (status <> 'running' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.billing_sync_jobs IS 'G5 outbox of Daftra sync jobs; claimed by the server-side worker (service role) one running job per org.';
CREATE UNIQUE INDEX IF NOT EXISTS billing_sync_jobs_dedupe_uidx ON public.billing_sync_jobs (org_id, dedupe_key) WHERE status IN ('queued','running','unknown');
CREATE INDEX IF NOT EXISTS billing_sync_jobs_claim_idx ON public.billing_sync_jobs (status, next_run_at, priority);
CREATE INDEX IF NOT EXISTS billing_sync_jobs_intent_idx ON public.billing_sync_jobs (intent_id) WHERE intent_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8. billing_sync_attempts — append-only request / response log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_sync_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  job_id       uuid NOT NULL,
  attempt_no   int NOT NULL CHECK (attempt_no >= 1),
  worker       text NOT NULL CHECK (char_length(worker) BETWEEN 1 AND 80),
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  outcome      text CHECK (outcome IN ('ok','retry','failed','unknown','conflict','frozen','abandoned','lease_lost')),
  adapter_mode text CHECK (adapter_mode IN ('mock','live')),
  calls        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(calls) = 'array' AND jsonb_array_length(calls) <= 50
                                                      AND octet_length(calls::text) <= 262144),
  error        jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT billing_sync_attempts_job_fk FOREIGN KEY (job_id, org_id) REFERENCES public.billing_sync_jobs(id, org_id),
  CONSTRAINT billing_sync_attempts_no_uniq UNIQUE (job_id, attempt_no),
  CONSTRAINT billing_sync_attempts_closed_chk CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.billing_sync_attempts IS 'G5 append-only log of worker attempts: every adapter call (request / response redacted). Opened at claim, closed exactly once.';
CREATE INDEX IF NOT EXISTS billing_sync_attempts_job_idx ON public.billing_sync_attempts (job_id, attempt_no);

-- ---------------------------------------------------------------------
-- 11. billing_review_items — adjustment / credit-note review queue
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_review_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  transaction_id     uuid NOT NULL,
  intent_id          uuid,
  charge_id          uuid,
  kind               text NOT NULL CHECK (kind IN ('late_charge','issued_mismatch','issued_cancelled')),
  details            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution         text CHECK (char_length(resolution) <= 40),
  resolution_note    text CHECK (char_length(resolution_note) <= 2000),
  resolved_intent_id uuid,
  resolved_by        uuid,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_review_items_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT billing_review_items_intent_fk FOREIGN KEY (intent_id, transaction_id) REFERENCES public.billing_intents(id, transaction_id),
  CONSTRAINT billing_review_items_charge_fk FOREIGN KEY (charge_id, transaction_id) REFERENCES public.client_charges(id, transaction_id),
  CONSTRAINT billing_review_items_resolved_fk FOREIGN KEY (resolved_intent_id, transaction_id) REFERENCES public.billing_intents(id, transaction_id),
  CONSTRAINT billing_review_items_charge_chk CHECK ((kind = 'late_charge') = (charge_id IS NOT NULL)),
  CONSTRAINT billing_review_items_closed_chk CHECK ((status = 'open') = (resolved_at IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.billing_review_items IS 'G5 review queue: late charges after issue, issued invoice differs, cancelled in Daftra. Marsa never edits an issued invoice.';
-- bounded details (the completion path keeps them ≤ 256 KiB: snapshot / diff dropped first)
ALTER TABLE public.billing_review_items DROP CONSTRAINT IF EXISTS billing_review_items_details_size_chk;
ALTER TABLE public.billing_review_items ADD CONSTRAINT billing_review_items_details_size_chk CHECK (octet_length(details::text) <= 262144) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS billing_review_items_charge_uidx ON public.billing_review_items (charge_id, kind) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS billing_review_items_intent_uidx ON public.billing_review_items (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL;
CREATE INDEX IF NOT EXISTS billing_review_items_tx_idx ON public.billing_review_items (transaction_id, status);

-- ---------------------------------------------------------------------
-- 14. daftra_mock_accounts — DB-backed fake Daftra account (staging demo; service role only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daftra_mock_accounts (
  org_id     uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  state      jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  version    int NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.daftra_mock_accounts IS 'G5 staging only: persistent state of the MOCK Daftra adapter per org. No policy: service role only.';

-- ---------------------------------------------------------------------
-- row triggers: derived / immutable columns
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_bill_client_link_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.client_ref := 'MRSC-' || NEW.client_id::text;
  ELSIF NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.client_ref IS DISTINCT FROM OLD.client_ref OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    PERFORM app.fail('MRS_IMMUTABLE', 'client_ref');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bill_before ON public.daftra_client_links;
CREATE TRIGGER trg_bill_before BEFORE INSERT OR UPDATE ON public.daftra_client_links FOR EACH ROW EXECUTE FUNCTION app.tg_bill_client_link_before();

CREATE OR REPLACE FUNCTION app.tg_bill_item_link_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.product_code := 'MRS-' || replace(NEW.item_key, ':', '-');
  ELSIF NEW.item_key IS DISTINCT FROM OLD.item_key OR NEW.product_code IS DISTINCT FROM OLD.product_code OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    PERFORM app.fail('MRS_IMMUTABLE', 'item_key');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bill_before ON public.daftra_item_links;
CREATE TRIGGER trg_bill_before BEFORE INSERT OR UPDATE ON public.daftra_item_links FOR EACH ROW EXECUTE FUNCTION app.tg_bill_item_link_before();

CREATE OR REPLACE FUNCTION app.tg_bill_intent_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.purpose_key IS DISTINCT FROM OLD.purpose_key OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.operational_ref IS DISTINCT FROM OLD.operational_ref) THEN
    PERFORM app.fail('MRS_IMMUTABLE', 'operational_ref');
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bill_before ON public.billing_intents;
CREATE TRIGGER trg_bill_before BEFORE INSERT OR UPDATE ON public.billing_intents FOR EACH ROW EXECUTE FUNCTION app.tg_bill_intent_before();

CREATE OR REPLACE FUNCTION app.tg_bill_line_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.line_ref := 'MRSL-' || upper(substr(replace(NEW.id::text, '-', ''), 1, 16));
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
       OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.charge_id IS DISTINCT FROM OLD.charge_id
       OR NEW.line_ref IS DISTINCT FROM OLD.line_ref OR NEW.item_key IS DISTINCT FROM OLD.item_key
       OR NEW.description IS DISTINCT FROM OLD.description OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.unit_price IS DISTINCT FROM OLD.unit_price OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
       OR NEW.vat_rate IS DISTINCT FROM OLD.vat_rate OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.service_code IS DISTINCT FROM OLD.service_code THEN
      PERFORM app.fail('MRS_IMMUTABLE', 'line');
    END IF;
    IF OLD.state = 'removed' AND NEW.state <> 'removed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'removed'); END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bill_before ON public.billing_intent_lines;
CREATE TRIGGER trg_bill_before BEFORE INSERT OR UPDATE ON public.billing_intent_lines FOR EACH ROW EXECUTE FUNCTION app.tg_bill_line_before();

-- local figures on the intent = Σ lines that will be on the invoice (pending_add + synced)
CREATE OR REPLACE FUNCTION app.tg_bill_line_totals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.billing_intents i SET
    lines_net = s.n, lines_vat = s.v, lines_total = s.t
    FROM (SELECT coalesce(sum(l.net_amount), 0) n, coalesce(sum(l.vat_amount), 0) v, coalesce(sum(l.total_amount), 0) t
            FROM public.billing_intent_lines l WHERE l.intent_id = NEW.intent_id AND l.state IN ('pending_add','synced')) s
   WHERE i.id = NEW.intent_id AND (i.lines_net, i.lines_vat, i.lines_total) IS DISTINCT FROM (s.n, s.v, s.t);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_bill_totals ON public.billing_intent_lines;
CREATE TRIGGER trg_bill_totals AFTER INSERT OR UPDATE OF state ON public.billing_intent_lines FOR EACH ROW EXECUTE FUNCTION app.tg_bill_line_totals();

-- attempts: opened at claim, closed exactly once (finished_at, outcome, calls, error); never deleted
CREATE OR REPLACE FUNCTION app.tg_bill_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  IF OLD.outcome IS NOT NULL OR NEW.outcome IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no OR NEW.worker IS DISTINCT FROM OLD.worker
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.adapter_mode IS DISTINCT FROM OLD.adapter_mode THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_append_only ON public.billing_sync_attempts;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.billing_sync_attempts FOR EACH ROW EXECUTE FUNCTION app.tg_bill_attempt_guard();
DROP TRIGGER IF EXISTS trg_append_only_trunc ON public.billing_sync_attempts;
CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON public.billing_sync_attempts FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();

-- ---------------------------------------------------------------------
-- charge guard + late charges (G4 client_charges, sell side)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bill_flag_on() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(current_setting('marsa.bill_invoiced', true), '') = 'on'
$$;

-- a billed charge cannot leave 'approved'; 'invoiced' is set / released only by the G5 completion path (flag)
CREATE OR REPLACE FUNCTION app.tg_bill_charge_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF (NEW.status = 'invoiced' OR OLD.status = 'invoiced') AND NOT app.bill_flag_on() THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'g5_only');
  END IF;
  IF OLD.status = 'approved' AND NEW.status <> 'invoiced'
     AND EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = OLD.id AND l.state <> 'removed') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'in_invoice');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bill_guard ON public.client_charges;
CREATE TRIGGER trg_bill_guard BEFORE UPDATE ON public.client_charges FOR EACH ROW EXECUTE FUNCTION app.tg_bill_charge_guard();

-- a charge approved after the transaction's invoice (same currency) was issued → late_charge review item
CREATE OR REPLACE FUNCTION app.tg_bill_late_charge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_intent uuid;
BEGIN
  IF NEW.status <> 'approved' OR (TG_OP = 'UPDATE' AND OLD.status = 'approved') OR app.bill_flag_on() THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = NEW.id AND l.state <> 'removed') THEN RETURN NULL; END IF;
  SELECT i.id INTO v_intent FROM public.billing_intents i
   WHERE i.transaction_id = NEW.transaction_id AND i.currency = NEW.currency AND i.status = 'issued'
   ORDER BY i.issued_at DESC NULLS LAST, i.created_at DESC LIMIT 1;
  IF v_intent IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, charge_id, kind, details)
  VALUES (NEW.org_id, NEW.transaction_id, v_intent, NEW.id, 'late_charge', jsonb_build_object('reason', 'approved_after_issue'))
  ON CONFLICT (charge_id, kind) WHERE status = 'open' DO NOTHING;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_bill_late ON public.client_charges;
CREATE TRIGGER trg_bill_late AFTER INSERT OR UPDATE OF status ON public.client_charges FOR EACH ROW EXECUTE FUNCTION app.tg_bill_late_charge();

-- G4 collection evidence (charge_collections) stays recordable once G5 has invoiced the charge (G5-5: shown side by side,
-- never merged). Body = G4 20261104000100 app.tg_collection_check; only the status check accepts 'invoiced' too.
CREATE OR REPLACE FUNCTION app.tg_collection_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.client_charges; v_sum numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status','void_reason','voided_by','voided_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','void_reason','voided_by','voided_at'])
       OR NOT (OLD.status = 'recorded' AND NEW.status = 'void') THEN
      PERFORM app.fail('MRS_APPEND_ONLY', TG_TABLE_NAME);
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = NEW.charge_id FOR UPDATE;
  IF v_c.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'charge_id'); END IF;
  IF v_c.status NOT IN ('approved','invoiced') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'charge_' || v_c.status); END IF;
  NEW.currency := v_c.currency; NEW.transaction_id := v_c.transaction_id; NEW.org_id := v_c.org_id;
  NEW.status := 'recorded'; NEW.void_reason := NULL; NEW.voided_by := NULL; NEW.voided_at := NULL;
  SELECT coalesce(sum(k.amount), 0) INTO v_sum FROM public.charge_collections k WHERE k.charge_id = v_c.id AND k.status = 'recorded';
  IF v_sum + NEW.amount > v_c.total_amount THEN PERFORM app.fail('MRS_OVERPAID', greatest(v_c.total_amount - v_sum, 0)::text); END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION app.tg_collection_check() FROM PUBLIC, anon, authenticated;

-- flagged status change of charges (completion / release only)
CREATE OR REPLACE FUNCTION app.bill_set_charges(p_ids uuid[], p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN; END IF;
  PERFORM set_config('marsa.bill_invoiced', 'on', true);
  UPDATE public.client_charges c SET status = p_status
   WHERE c.id = ANY (p_ids) AND c.status = CASE p_status WHEN 'invoiced' THEN 'approved' ELSE 'invoiced' END;
  PERFORM set_config('marsa.bill_invoiced', 'off', true);
END $$;

-- ---------------------------------------------------------------------
-- events, connection, JSON helpers
-- ---------------------------------------------------------------------
-- one internal billing event (never amounts, never bodies): payload {op, entity, id} || ids
CREATE OR REPLACE FUNCTION app.bill_event(p_org uuid, p_tx uuid, p_op text, p_entity text, p_id uuid,
  p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_tx IS NULL THEN RETURN; END IF;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, actor, payload)
  VALUES (p_org, p_tx, 'billing', false, auth.uid(),
          jsonb_build_object('op', p_op, 'entity', p_entity, 'id', p_id) || jsonb_strip_nulls(coalesce(p_extra, '{}'::jsonb)));
END $$;

CREATE OR REPLACE FUNCTION app.bill_missing_caps(p_caps jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(k ORDER BY o), '{}'::text[])
    FROM unnest(app.bill_required_caps()) WITH ORDINALITY x(k, o)
   WHERE coalesce(p_caps -> k -> 'supported', 'false'::jsonb) <> 'true'::jsonb
$$;

-- the connection as JSON (defaults when the org has no row yet: exists false)
CREATE OR REPLACE FUNCTION app.bill_conn_json(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT to_jsonb(c) || jsonb_build_object('exists', true) FROM public.daftra_connections c WHERE c.org_id = p_org),
    jsonb_build_object('id', NULL, 'org_id', p_org, 'mode', 'mock', 'status', 'not_connected', 'subdomain', NULL, 'sync_enabled', false,
      'capabilities', '{}'::jsonb, 'capabilities_checked_at', NULL, 'capabilities_source', NULL, 'last_check_at', NULL,
      'last_check_status', NULL, 'last_error_code', NULL, 'last_error_message', NULL, 'default_service_vat_rate', 15,
      'allowed_vat_rates', '[0, 15]'::jsonb, 'reimbursable_tax_code', 'out_of_scope', 'invoice_notes', NULL, 'exists', false))
$$;

-- push gate on the connection: NULL when ready, else the MRS_BAD_TRANSITION detail word
CREATE OR REPLACE FUNCTION app.bill_conn_block(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN c.id IS NULL OR c.status <> 'connected' OR NOT c.sync_enabled THEN 'not_connected'
              WHEN cardinality(app.bill_missing_caps(c.capabilities)) > 0 THEN 'capability' END
    FROM (SELECT 1) one LEFT JOIN public.daftra_connections c ON c.org_id = p_org
$$;

-- policy helper (RLS runs it as the caller): intent jobs by the intent's transaction, org jobs by the org
CREATE OR REPLACE FUNCTION app.bill_can_read_job(j public.billing_sync_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN j.intent_id IS NOT NULL
              THEN EXISTS (SELECT 1 FROM public.billing_intents i
                            WHERE i.id = j.intent_id AND app.has_tx_role(i.transaction_id, app.fin_read_roles()))
              ELSE app.has_role(j.org_id, app.fin_read_roles()) END
$$;

-- drift: local:<field> where the Marsa client ≠ pushed; remote:<field> where Daftra ≠ pushed
CREATE OR REPLACE FUNCTION app.bill_client_drift(l public.daftra_client_links) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN l.pushed_snapshot IS NULL THEN '{}'::text[] ELSE coalesce((
    SELECT array_agg(x.d ORDER BY x.d) FROM (
      SELECT 'local:' || k AS d FROM unnest(app.bill_snapshot_keys()) k, public.clients c
       WHERE c.id = l.client_id AND (app.bill_client_snapshot(c) ->> k) IS DISTINCT FROM (l.pushed_snapshot ->> k)
      UNION ALL
      SELECT 'remote:' || k FROM unnest(app.bill_snapshot_keys()) k
       WHERE l.remote_snapshot IS NOT NULL AND (l.remote_snapshot ->> k) IS DISTINCT FROM (l.pushed_snapshot ->> k)) x), '{}'::text[]) END
$$;
-- effective link status (drift ⇄ linked follows the live drift)
CREATE OR REPLACE FUNCTION app.bill_link_status(l public.daftra_client_links) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN l.status IN ('linked','drift')
              THEN CASE WHEN cardinality(app.bill_client_drift(l)) > 0 THEN 'drift' ELSE 'linked' END
              ELSE l.status END
$$;

CREATE OR REPLACE FUNCTION app.bill_link_json(l public.daftra_client_links) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(l) || jsonb_build_object(
    'status', app.bill_link_status(l), 'stored_status', l.status, 'drift', to_jsonb(app.bill_client_drift(l)),
    'client_name', c.name_ar, 'client_name_en', c.name_en, 'vat_number', c.vat_number,
    'local_snapshot', app.bill_client_snapshot(c))
    FROM public.clients c WHERE c.id = l.client_id
$$;

-- every possible item key: 3 kinds × (fin_service codes + none)
CREATE OR REPLACE FUNCTION app.bill_all_item_keys() RETURNS TABLE (item_key text, ord int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT k.kind || ':' || s.code, (k.ko * 1000 + s.sort)::int
    FROM unnest(ARRAY['service','internal_service','reimbursable']) WITH ORDINALITY k(kind, ko)
   CROSS JOIN (SELECT sl.code, sl.sort FROM public.status_labels sl WHERE sl.domain = 'fin_service'
               UNION ALL SELECT 'none', 999) s
$$;

-- canonical names / tax defaults of an item key (G5-3: reimbursable → 0 % + the org's reimbursable tax code)
CREATE OR REPLACE FUNCTION app.bill_item_defaults(p_org uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text := split_part(p_key, ':', 1); v_code text := split_part(p_key, ':', 2);
        v_ar text; v_en text; v_rate numeric; v_tax text;
BEGIN
  SELECT c.default_service_vat_rate, c.reimbursable_tax_code INTO v_rate, v_tax FROM public.daftra_connections c WHERE c.org_id = p_org;
  IF v_code = 'none' THEN v_ar := 'خدمات أخرى'; v_en := 'Other services';
  ELSE SELECT s.label_ar, s.label_en INTO v_ar, v_en FROM public.status_labels s WHERE s.domain = 'fin_service' AND s.code = v_code;
  END IF;
  v_ar := coalesce(v_ar, v_code) || CASE v_kind WHEN 'reimbursable' THEN ' — مبلغ مسترد' WHEN 'internal_service' THEN ' — خدمة داخلية' ELSE '' END;
  v_en := coalesce(v_en, v_code) || CASE v_kind WHEN 'reimbursable' THEN ' — reimbursable' WHEN 'internal_service' THEN ' — internal service' ELSE '' END;
  RETURN jsonb_build_object('item_key', p_key, 'product_code', 'MRS-' || replace(p_key, ':', '-'), 'name_ar', v_ar, 'name_en', v_en,
    'default_vat_rate', CASE WHEN v_kind = 'reimbursable' THEN 0 ELSE coalesce(v_rate, 15) END,
    'tax_code', CASE WHEN v_kind = 'reimbursable' THEN coalesce(v_tax, 'out_of_scope') ELSE 'standard' END);
END $$;

CREATE OR REPLACE FUNCTION app.bill_item_json(i public.daftra_item_links) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT to_jsonb(i) || jsonb_build_object('mapped', true)
$$;

CREATE OR REPLACE FUNCTION app.bill_line_json(l public.billing_intent_lines) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT to_jsonb(l)
$$;

CREATE OR REPLACE FUNCTION app.bill_intent_json(i public.billing_intents) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(i) || jsonb_build_object(
    'transaction_ref', t.ref, 'branch_id', t.branch_id, 'client_name', c.name_ar,
    'line_count', (SELECT count(*)::int FROM public.billing_intent_lines l WHERE l.intent_id = i.id AND l.state <> 'removed'),
    'figures_differ', i.remote_total IS NOT NULL AND i.remote_total <> i.lines_total)
    FROM public.transactions t JOIN public.clients c ON c.id = i.client_id
   WHERE t.id = i.transaction_id
$$;

CREATE OR REPLACE FUNCTION app.bill_job_json(j public.billing_sync_jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(j) || jsonb_build_object(
    'transaction_id', i.transaction_id, 'operational_ref', i.operational_ref,
    'branch_id', (SELECT t.branch_id FROM public.transactions t WHERE t.id = i.transaction_id),
    'last_attempt', (SELECT jsonb_build_object('id', a.id, 'attempt_no', a.attempt_no, 'outcome', a.outcome, 'worker', a.worker,
                                               'started_at', a.started_at, 'finished_at', a.finished_at, 'error', a.error)
                       FROM public.billing_sync_attempts a WHERE a.job_id = j.id ORDER BY a.attempt_no DESC LIMIT 1))
    FROM (SELECT 1) one LEFT JOIN public.billing_intents i ON i.id = j.intent_id
$$;

-- ---------------------------------------------------------------------
-- outbox / links / lines helpers
-- ---------------------------------------------------------------------
-- enqueue a job, or return the live one with the same dedupe key (deduplicated true; a queued job takes the new options)
CREATE OR REPLACE FUNCTION app.bill_enqueue(p_org uuid, p_kind text, p_intent uuid, p_client_link uuid, p_item_link uuid,
  p_options jsonb DEFAULT '{}'::jsonb, p_by uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key text; v_j public.billing_sync_jobs; v_dedup boolean := false;
BEGIN
  v_key := CASE WHEN p_kind = 'probe' THEN 'probe' ELSE p_kind || ':' || coalesce(p_intent, p_client_link, p_item_link)::text END;
  INSERT INTO public.billing_sync_jobs (org_id, kind, intent_id, client_link_id, item_link_id, dedupe_key, options, priority, requested_by)
  VALUES (p_org, p_kind, p_intent, p_client_link, p_item_link, v_key, coalesce(p_options, '{}'::jsonb),
          CASE p_kind WHEN 'probe' THEN 0 WHEN 'invoice_push' THEN 2 WHEN 'invoice_pull' THEN 3 ELSE 1 END, p_by)
  ON CONFLICT (org_id, dedupe_key) WHERE status IN ('queued','running','unknown') DO NOTHING
  RETURNING * INTO v_j;
  IF v_j.id IS NULL THEN
    SELECT * INTO v_j FROM public.billing_sync_jobs j
     WHERE j.org_id = p_org AND j.dedupe_key = v_key AND j.status IN ('queued','running','unknown') FOR UPDATE;
    v_dedup := true;
    IF v_j.status = 'queued' AND coalesce(p_options, '{}'::jsonb) <> '{}'::jsonb AND NOT (v_j.options @> p_options) THEN
      UPDATE public.billing_sync_jobs j SET options = j.options || p_options WHERE j.id = v_j.id RETURNING * INTO v_j;
    END IF;
  END IF;
  RETURN app.bill_job_json(v_j) || jsonb_build_object('deduplicated', v_dedup);
END $$;

-- the org's live link of a client (created 'pending' when missing)
CREATE OR REPLACE FUNCTION app.bill_ensure_client_link(p_org uuid, p_client uuid) RETURNS public.daftra_client_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_client_links;
BEGIN
  SELECT * INTO v FROM public.daftra_client_links l WHERE l.org_id = p_org AND l.client_id = p_client AND l.status <> 'unlinked';
  IF v.id IS NULL THEN
    INSERT INTO public.daftra_client_links (org_id, client_id, client_ref, created_by)
    VALUES (p_org, p_client, 'MRSC-' || p_client::text, auth.uid())
    ON CONFLICT (org_id, client_id) WHERE status <> 'unlinked' DO NOTHING RETURNING * INTO v;
    IF v.id IS NULL THEN
      SELECT * INTO v FROM public.daftra_client_links l WHERE l.org_id = p_org AND l.client_id = p_client AND l.status <> 'unlinked';
    END IF;
  END IF;
  RETURN v;
END $$;

-- the org's live mapping of an item key (created 'pending' with the defaults when missing)
CREATE OR REPLACE FUNCTION app.bill_ensure_item(p_org uuid, p_key text) RETURNS public.daftra_item_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_item_links; d jsonb;
BEGIN
  SELECT * INTO v FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.item_key = p_key AND i.status <> 'retired';
  IF v.id IS NULL THEN
    d := app.bill_item_defaults(p_org, p_key);
    INSERT INTO public.daftra_item_links (org_id, item_key, product_code, name_ar, name_en, default_vat_rate, tax_code, updated_by)
    VALUES (p_org, p_key, d ->> 'product_code', d ->> 'name_ar', d ->> 'name_en', (d ->> 'default_vat_rate')::numeric, d ->> 'tax_code', auth.uid())
    ON CONFLICT (org_id, item_key) WHERE status <> 'retired' DO NOTHING RETURNING * INTO v;
    IF v.id IS NULL THEN
      SELECT * INTO v FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.item_key = p_key AND i.status <> 'retired';
    END IF;
  END IF;
  RETURN v;
END $$;

-- a local change on a pushed intent → sync_state pending (in_flight / unknown / conflict are kept)
CREATE OR REPLACE FUNCTION app.bill_local_change(p_intent uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.billing_intents i SET sync_state = 'pending' WHERE i.id = p_intent AND i.sync_state IN ('synced','error')
$$;

-- «possibly applied»: an invoice_push job with an attempt that ended unknown / abandoned / lease_lost and no later
-- attempt that read the remote (ok / frozen / conflict). Sticky across retry / failed / dead until a reconcile succeeds.
CREATE OR REPLACE FUNCTION app.bill_job_unreconciled(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.billing_sync_jobs j JOIN public.billing_sync_attempts a ON a.job_id = j.id
     WHERE j.id = p_job AND j.kind = 'invoice_push' AND j.status NOT IN ('done','cancelled')
       AND a.outcome IN ('unknown','abandoned','lease_lost')
       AND NOT EXISTS (SELECT 1 FROM public.billing_sync_attempts b
                        WHERE b.job_id = j.id AND b.attempt_no > a.attempt_no AND b.outcome IN ('ok','frozen','conflict')))
$$;

-- an intent with a possibly-applied write not reconciled yet (a later invoice_push job that ended done settles it)
CREATE OR REPLACE FUNCTION app.bill_unreconciled(p_intent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.billing_sync_jobs j
     WHERE j.intent_id = p_intent AND j.kind = 'invoice_push' AND app.bill_job_unreconciled(j.id)
       AND NOT EXISTS (SELECT 1 FROM public.billing_sync_jobs k
                        WHERE k.intent_id = p_intent AND k.kind = 'invoice_push' AND k.status = 'done'
                          AND (k.created_at, k.id) > (j.created_at, j.id)))
$$;

-- a charge held by an open issued_mismatch item: its removed line was found on the issued Daftra invoice
CREATE OR REPLACE FUNCTION app.bill_charge_held(p_tx uuid, p_charge uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.billing_review_items r
                  WHERE r.transaction_id = p_tx AND r.kind = 'issued_mismatch' AND r.status = 'open'
                    AND r.details -> 'removed_on_remote' @> jsonb_build_array(jsonb_build_object('charge_id', p_charge)))
$$;

-- add eligible approved charges (same transaction + currency, not on a live line) as pending_add lines
CREATE OR REPLACE FUNCTION app.bill_add_lines(p_i public.billing_intents, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.client_charges; v_l public.billing_intent_lines; v_out jsonb := '[]'::jsonb; v_id uuid; v_added uuid[] := '{}';
BEGIN
  IF p_ids IS NOT NULL THEN
    IF cardinality(p_ids) > 200 THEN PERFORM app.fail('MRS_INVALID', 'charge_ids'); END IF;
    FOREACH v_id IN ARRAY p_ids LOOP
      SELECT * INTO v_c FROM public.client_charges c WHERE c.id = v_id AND c.transaction_id = p_i.transaction_id FOR UPDATE;
      IF v_id IS NULL OR v_c.id IS NULL OR v_c.status <> 'approved' OR v_c.currency <> p_i.currency
         OR EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = v_id AND l.state <> 'removed')
         OR app.bill_charge_held(p_i.transaction_id, v_id) THEN
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
    INSERT INTO public.billing_intent_lines (org_id, transaction_id, intent_id, charge_id, line_ref, item_key, description, quantity,
      unit_price, net_amount, vat_rate, vat_amount, total_amount, currency, kind, service_code, added_by)
    VALUES (p_i.org_id, p_i.transaction_id, p_i.id, v_c.id, 'MRSL-0000000000000000', app.bill_item_key(v_c.kind, v_c.service_code),
      v_c.description, v_c.quantity, v_c.unit_price, v_c.net_amount, v_c.vat_rate, v_c.vat_amount, v_c.total_amount, v_c.currency,
      v_c.kind, v_c.service_code, auth.uid())
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

-- G5-7: financial_status driven by G5, forward only (draft_pending → invoiced → settled)
CREATE OR REPLACE FUNCTION app.bill_tx_financial(p_tx uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_target text;
BEGIN
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v_tx.id IS NULL THEN RETURN; END IF;
  SELECT CASE
           WHEN bool_or(i.status = 'issued') AND NOT bool_or(i.status = 'issued' AND i.payment_status <> 'paid')
                AND NOT bool_or(i.status IN ('open','draft')) THEN 'settled'
           WHEN bool_or(i.status = 'issued') THEN 'invoiced'
           WHEN bool_or(i.status IN ('open','draft') AND i.external_invoice_id IS NOT NULL) THEN 'draft_pending' END
    INTO v_target
    FROM public.billing_intents i WHERE i.transaction_id = p_tx AND i.status <> 'cancelled';
  IF v_target IS NULL OR app.code_sort('financial_status', v_target) <= app.code_sort('financial_status', v_tx.financial_status) THEN
    RETURN;
  END IF;
  UPDATE public.transactions t SET financial_status = v_target WHERE t.id = p_tx;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'financial_status', v_tx.financial_status, v_target, false, auth.uid(), jsonb_build_object('source', 'g5'));
END $$;

-- read an intent for a write: invisible (no finance read at its transaction) → MRS_NOT_FOUND; lock tx (role) then the intent
CREATE OR REPLACE FUNCTION app.bill_lock_intent(p_intent uuid, p_roles text[]) RETURNS public.billing_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.billing_intents;
BEGIN
  SELECT * INTO v FROM public.billing_intents i WHERE i.id = p_intent;
  IF v.id IS NULL OR NOT app.has_tx_role(v.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'intent'); END IF;
  PERFORM app.g3_lock_tx(v.transaction_id, p_roles);
  SELECT * INTO v FROM public.billing_intents i WHERE i.id = p_intent FOR UPDATE;
  RETURN v;
END $$;

-- cancel the queued jobs of an intent / link / item
CREATE OR REPLACE FUNCTION app.bill_cancel_jobs(p_intent uuid, p_link uuid, p_item uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.billing_sync_jobs j SET status = 'cancelled', finished_at = now()
   WHERE j.status = 'queued'
     AND ((p_intent IS NOT NULL AND j.intent_id = p_intent) OR (p_link IS NOT NULL AND j.client_link_id = p_link)
          OR (p_item IS NOT NULL AND j.item_link_id = p_item))
$$;

-- release an intent: cancelled, live lines removed, charges stay / become approved (eligible again)
CREATE OR REPLACE FUNCTION app.bill_release(p_i public.billing_intents, p_reason text, p_line_reason text) RETURNS public.billing_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.billing_intents; v_ids uuid[];
BEGIN
  SELECT coalesce(array_agg(l.charge_id ORDER BY l.id), '{}') INTO v_ids FROM public.billing_intent_lines l
   WHERE l.intent_id = p_i.id AND l.state <> 'removed';
  UPDATE public.billing_intent_lines l SET state = 'removed', removed_reason = p_line_reason, removed_by = auth.uid(), removed_at = now()
   WHERE l.intent_id = p_i.id AND l.state <> 'removed';
  PERFORM app.bill_set_charges(v_ids, 'approved');
  UPDATE public.billing_intents i SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = p_reason,
         sync_state = CASE WHEN i.sync_state IN ('in_flight','unknown') THEN i.sync_state ELSE 'idle' END, conflict = NULL
   WHERE i.id = p_i.id RETURNING * INTO v;
  PERFORM app.bill_cancel_jobs(p_i.id, NULL, NULL);
  RETURN v;
END $$;

-- a diff for a review item: array, first 500 entries, redacted (never raises: issuance is never aborted by its size)
CREATE OR REPLACE FUNCTION app.bill_diff_cap(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN '[]'::jsonb
              ELSE app.bill_redact(coalesce((SELECT jsonb_agg(x.e ORDER BY x.o) FROM jsonb_array_elements(p) WITH ORDINALITY x(e, o) WHERE x.o <= 500), '[]'::jsonb)) END
$$;

-- review details / conflict record ≤ 256 KiB: the snapshot goes first, then the diff (hashes and ids stay)
CREATE OR REPLACE FUNCTION app.bill_bound_details(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p;
BEGIN
  IF v IS NULL OR octet_length(v::text) <= 262144 THEN RETURN v; END IF;
  v := (v - 'remote_snapshot') || jsonb_build_object('truncated', true);
  IF octet_length(v::text) <= 262144 THEN RETURN v; END IF;
  v := (v - 'diff') || jsonb_build_object('diff', '[]'::jsonb);
  IF octet_length(v::text) <= 262144 THEN RETURN v; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('truncated', true, 'diff', '[]'::jsonb, 'pushed_hash', v -> 'pushed_hash', 'remote_hash', v -> 'remote_hash',
                                              'reason', v -> 'reason', 'detected_at', v -> 'detected_at', 'external_invoice_id', v -> 'external_invoice_id'));
END $$;

-- §10 frozen: the remote invoice is issued → intent issued, its lines frozen, charges invoiced, late / mismatch review items
CREATE OR REPLACE FUNCTION app.bill_mark_issued(p_i public.billing_intents, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_snap jsonb := p_eff -> 'remote_snapshot'; v_refs text[]; v_inv uuid[] := '{}'; v_late uuid[] := '{}'; v_l public.billing_intent_lines;
        v_hash text := p_eff ->> 'remote_hash'; v_held jsonb; v_det jsonb;
BEGIN
  v_refs := ARRAY(SELECT x ->> 'line_ref' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_snap -> 'lines') = 'array' THEN v_snap -> 'lines' ELSE '[]'::jsonb END) x
                   WHERE jsonb_typeof(x) = 'object' AND x ->> 'line_ref' IS NOT NULL);
  FOR v_l IN SELECT * FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND l.state <> 'removed' ORDER BY l.id FOR UPDATE LOOP
    IF v_l.line_ref = ANY (v_refs) THEN
      UPDATE public.billing_intent_lines l SET state = 'synced', pushed = true WHERE l.id = v_l.id AND (l.state <> 'synced' OR NOT l.pushed);
      v_inv := v_inv || v_l.charge_id;
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
  IF (p_i.pushed_hash IS NOT NULL AND v_hash IS DISTINCT FROM p_i.pushed_hash) OR jsonb_array_length(v_held) > 0 THEN
    -- the same redaction and bounds as the conflict path (bill_apply_conflict); an oversize snapshot / diff is dropped
    v_det := jsonb_build_object('diff', app.bill_diff_cap(p_eff -> 'diff'), 'pushed_hash', p_i.pushed_hash, 'remote_hash', v_hash,
                                'remote_snapshot', app.bill_redact(CASE WHEN jsonb_typeof(v_snap) = 'object' THEN v_snap END),
                                'removed_on_remote', v_held);
    IF jsonb_array_length(v_held) = 0 THEN v_det := v_det - 'removed_on_remote'; END IF;
    v_det := app.bill_bound_details(v_det);
    INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
    VALUES (p_i.org_id, p_i.transaction_id, p_i.id, 'issued_mismatch', v_det)
    ON CONFLICT (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL DO NOTHING;
  END IF;
  UPDATE public.billing_intents i SET status = 'issued', issued_at = coalesce(i.issued_at, now()), sync_state = 'synced', conflict = NULL
   WHERE i.id = p_i.id;
  PERFORM app.bill_event(p_i.org_id, p_i.transaction_id, 'issued', 'billing_intent', p_i.id,
    jsonb_build_object('charge_ids', to_jsonb(v_inv), 'late_charge_ids', CASE WHEN cardinality(v_late) > 0 THEN to_jsonb(v_late) END));
END $$;

-- =====================================================================
-- staff RPCs (authenticated)
-- =====================================================================

-- ---------------------------------------------------------------------
-- connection & probe
-- ---------------------------------------------------------------------
-- get_daftra_connection(p_org) → {connection, counts, push_ready, missing_capabilities}
CREATE OR REPLACE FUNCTION public.get_daftra_connection(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_conn jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  v_conn := app.bill_conn_json(p_org);
  RETURN jsonb_build_object(
    'connection', v_conn,
    'counts', jsonb_build_object(
      'jobs_by_status', coalesce((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT j.status, count(*)::int n FROM public.billing_sync_jobs j
                                   WHERE j.org_id = p_org AND app.bill_can_read_job(j) GROUP BY j.status) x), '{}'::jsonb),
      'links_by_status', coalesce((SELECT jsonb_object_agg(x.s, x.n) FROM (SELECT app.bill_link_status(l) s, count(*)::int n
                                   FROM public.daftra_client_links l WHERE l.org_id = p_org GROUP BY 1) x), '{}'::jsonb),
      'items_by_status', coalesce((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT i.status, count(*)::int n FROM public.daftra_item_links i
                                   WHERE i.org_id = p_org GROUP BY i.status) x), '{}'::jsonb)),
    'push_ready', app.bill_conn_block(p_org) IS NULL,
    'missing_capabilities', to_jsonb(app.bill_missing_caps(v_conn -> 'capabilities')),
    'can', jsonb_build_object('admin', app.has_role(p_org, app.bill_admin_roles())));
END $$;

-- save_daftra_connection(p_org, {mode, subdomain, sync_enabled, default_service_vat_rate, allowed_vat_rates, reimbursable_tax_code, invoice_notes})
CREATE OR REPLACE FUNCTION public.save_daftra_connection(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_connections; v_old public.daftra_connections; v_mode text; v_sub text; v_sync boolean; v_rate numeric;
        v_rates numeric[]; v_tax text; e jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['mode','subdomain','sync_enabled','default_service_vat_rate','allowed_vat_rates',
                                         'reimbursable_tax_code','invoice_notes']);
  INSERT INTO public.daftra_connections (org_id, created_by, updated_by) VALUES (p_org, auth.uid(), auth.uid())
  ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v_old FROM public.daftra_connections c WHERE c.org_id = p_org FOR UPDATE;
  v := v_old;
  IF p_payload ? 'mode' THEN
    v_mode := app.ptext(p_payload, 'mode', 20, true);
    IF v_mode NOT IN ('mock','live_pending') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
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
  -- status: a mode change forces a new probe; switching sync off / on toggles connected ⇄ disabled
  IF v.mode IS DISTINCT FROM v_old.mode THEN
    v.status := 'not_connected'; v.capabilities := '{}'::jsonb; v.capabilities_checked_at := NULL; v.capabilities_source := NULL;
  ELSIF v.sync_enabled IS DISTINCT FROM v_old.sync_enabled THEN
    IF NOT v.sync_enabled AND v_old.status = 'connected' THEN v.status := 'disabled';
    ELSIF v.sync_enabled AND v_old.status = 'disabled' THEN
      v.status := CASE WHEN v_old.last_check_status = 'ok' THEN 'connected' ELSE 'not_connected' END;
    END IF;
  END IF;
  UPDATE public.daftra_connections c SET mode = v.mode, subdomain = v.subdomain, sync_enabled = v.sync_enabled,
         default_service_vat_rate = v.default_service_vat_rate, allowed_vat_rates = v.allowed_vat_rates,
         reimbursable_tax_code = v.reimbursable_tax_code, invoice_notes = v.invoice_notes, status = v.status,
         capabilities = v.capabilities, capabilities_checked_at = v.capabilities_checked_at, capabilities_source = v.capabilities_source,
         updated_by = auth.uid()
   WHERE c.id = v_old.id RETURNING * INTO v;
  RETURN app.bill_conn_json(p_org) || jsonb_build_object('from', v_old.status);
END $$;

-- request_daftra_probe(p_org, p_idem_key) → job
CREATE OR REPLACE FUNCTION public.request_daftra_probe(p_org uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('request_daftra_probe', p_idem_key, jsonb_build_object('org', p_org), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  INSERT INTO public.daftra_connections (org_id, created_by, updated_by) VALUES (p_org, auth.uid(), auth.uid())
  ON CONFLICT (org_id) DO NOTHING;
  RETURN app.idem_finish('request_daftra_probe', p_idem_key, app.bill_enqueue(p_org, 'probe', NULL, NULL, NULL, '{}'::jsonb, auth.uid()));
END $$;

-- ---------------------------------------------------------------------
-- client links (step ٣)
-- ---------------------------------------------------------------------
-- list_daftra_client_links(p_org, {status, q, billable_only, limit, offset})
CREATE OR REPLACE FUNCTION public.list_daftra_client_links(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_status text; v_q text; v_bill boolean; v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['status','q','billable_only','limit','offset']);
  v_status := app.ptext(f, 'status', 20);
  v_q := app.ptext(f, 'q', 80);
  v_bill := app.pbool(f, 'billable_only');
  v_limit := least(coalesce(app.pnum(f, 'limit', 1000000)::int, 50), 200);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000000)::int, 0);
  RETURN (
    WITH billable AS (
      SELECT t.client_id, count(*)::int n FROM public.client_charges ch JOIN public.transactions t ON t.id = ch.transaction_id
       WHERE ch.org_id = p_org AND ch.status = 'approved' AND t.org_id = p_org
         AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())     -- counts only from transactions the caller can read
       GROUP BY t.client_id),
    lrows AS (
      SELECT l, c, app.bill_link_status(l) st FROM public.daftra_client_links l JOIN public.clients c ON c.id = l.client_id
       WHERE l.org_id = p_org
         AND (v_q IS NULL OR c.name_ar ILIKE '%' || v_q || '%' OR coalesce(c.name_en, '') ILIKE '%' || v_q || '%'
              OR coalesce(c.vat_number, '') = v_q OR l.client_ref = v_q OR coalesce(l.external_id, '') = v_q)
         AND (NOT v_bill OR l.client_id IN (SELECT b.client_id FROM billable b))),
    filtered AS (SELECT * FROM lrows r WHERE v_status IS NULL OR r.st = v_status)
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(app.bill_link_json(x.l) ORDER BY (x.c).name_ar, (x.l).created_at)
                           FROM (SELECT * FROM filtered ORDER BY (filtered.c).name_ar, (filtered.l).created_at LIMIT v_limit OFFSET v_offset) x), '[]'::jsonb),
      'total', (SELECT count(*)::int FROM filtered),
      'counts', coalesce((SELECT jsonb_object_agg(z.st, z.n) FROM (SELECT r.st, count(*)::int n FROM lrows r GROUP BY r.st) z), '{}'::jsonb),
      'unlinked', coalesce((SELECT jsonb_agg(jsonb_build_object('client_id', c.id, 'name_ar', c.name_ar, 'name_en', c.name_en,
                                                                'vat_number', c.vat_number, 'client_ref', 'MRSC-' || c.id::text,
                                                                'approved_count', b.n) ORDER BY c.name_ar)
                              FROM public.clients c JOIN billable b ON b.client_id = c.id
                             WHERE c.org_id = p_org
                               AND NOT EXISTS (SELECT 1 FROM public.daftra_client_links l WHERE l.client_id = c.id AND l.status <> 'unlinked')), '[]'::jsonb)));
END $$;

-- link_daftra_client(p_client, p_external_id, p_idem_key) → {link, job}
CREATE OR REPLACE FUNCTION public.link_daftra_client(p_client uuid, p_external_id text DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.clients; v_l public.daftra_client_links; v_replay jsonb; v_ext text := nullif(btrim(coalesce(p_external_id, '')), '');
        v_other uuid; v_job jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.clients c WHERE c.id = p_client;
  IF v_c.id IS NULL OR NOT app.is_staff(v_c.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  IF NOT app.has_role(v_c.org_id, app.fin_write_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF v_ext IS NOT NULL AND v_ext !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN PERFORM app.fail('MRS_INVALID', 'external_id'); END IF;
  v_replay := app.idem_begin('link_daftra_client', p_idem_key, jsonb_build_object('client', p_client, 'external_id', v_ext), v_c.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_l := app.bill_ensure_client_link(v_c.org_id, v_c.id);
  SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.id = v_l.id FOR UPDATE;
  IF v_ext IS NOT NULL AND v_ext IS DISTINCT FROM v_l.external_id THEN
    IF v_l.external_id IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'link_exists', v_l.id::text); END IF;
    SELECT l.id INTO v_other FROM public.daftra_client_links l
     WHERE l.org_id = v_c.org_id AND l.external_id = v_ext AND l.status <> 'unlinked' AND l.id <> v_l.id;
    IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
    UPDATE public.daftra_client_links l SET external_id = v_ext, status = 'pending', candidates = NULL, linked_by = auth.uid(),
           pushed_snapshot = NULL, remote_snapshot = NULL, drift = '{}'
     WHERE l.id = v_l.id RETURNING * INTO v_l;
  END IF;
  v_job := app.bill_enqueue(v_c.org_id, CASE WHEN v_l.external_id IS NULL THEN 'client_ensure' ELSE 'client_refresh' END,
                            NULL, v_l.id, NULL, '{}'::jsonb, auth.uid());
  RETURN app.idem_finish('link_daftra_client', p_idem_key, jsonb_build_object('link', app.bill_link_json(v_l), 'job', v_job));
END $$;

-- org-level link lookup for a write (MRS_NOT_FOUND invisible; MRS_FORBIDDEN without the role)
CREATE OR REPLACE FUNCTION app.bill_lock_link(p_link uuid, p_roles text[]) RETURNS public.daftra_client_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_client_links;
BEGIN
  SELECT * INTO v FROM public.daftra_client_links l WHERE l.id = p_link;
  IF v.id IS NULL OR NOT app.has_role(v.org_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'link'); END IF;
  IF NOT app.has_role(v.org_id, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  SELECT * INTO v FROM public.daftra_client_links l WHERE l.id = p_link FOR UPDATE;
  IF v.status = 'unlinked' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'unlinked'); END IF;
  RETURN v;
END $$;

-- refresh_daftra_client(p_link) → job (client_refresh with an external id, else client_ensure)
CREATE OR REPLACE FUNCTION public.refresh_daftra_client(p_link uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.daftra_client_links;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_l := app.bill_lock_link(p_link, app.fin_write_roles());
  IF v_l.status = 'needs_review' THEN PERFORM app.fail('MRS_REQUIRED', 'client_review'); END IF;
  RETURN app.bill_enqueue(v_l.org_id, CASE WHEN v_l.external_id IS NULL THEN 'client_ensure' ELSE 'client_refresh' END,
                          NULL, v_l.id, NULL, '{}'::jsonb, auth.uid());
END $$;

-- resolve_client_drift(p_link, push_local | acknowledge | choose | create_new, p_note, p_external_id)
CREATE OR REPLACE FUNCTION public.resolve_client_drift(p_link uuid, p_decision text, p_note text, p_external_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.daftra_client_links; v_note text; v_job jsonb; v_other uuid; v_ext text := nullif(btrim(coalesce(p_external_id, '')), '');
        v_caps jsonb; v_st text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_l := app.bill_lock_link(p_link, app.fin_approve_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('push_local','acknowledge','choose','create_new') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.fin_note(p_note, 'note');
  v_st := app.bill_link_status(v_l);
  IF p_decision IN ('push_local','acknowledge') THEN
    IF v_st NOT IN ('linked','drift') OR v_l.external_id IS NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_st); END IF;
    IF p_decision = 'push_local' THEN
      SELECT c.capabilities INTO v_caps FROM public.daftra_connections c WHERE c.org_id = v_l.org_id;
      IF coalesce(v_caps -> 'clients.update' -> 'supported', 'false'::jsonb) <> 'true'::jsonb THEN
        PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'capability', 'clients.update');
      END IF;
      v_job := app.bill_enqueue(v_l.org_id, 'client_push', NULL, v_l.id, NULL, '{}'::jsonb, auth.uid());
    ELSE
      -- Daftra's data becomes the baseline; the Marsa client row is never changed by G5
      UPDATE public.daftra_client_links l SET pushed_snapshot = coalesce(l.remote_snapshot, l.pushed_snapshot) WHERE l.id = v_l.id RETURNING * INTO v_l;
      UPDATE public.daftra_client_links l SET drift = app.bill_client_drift(v_l), status = app.bill_link_status(v_l),
             drift_detected_at = CASE WHEN cardinality(app.bill_client_drift(v_l)) > 0 THEN coalesce(l.drift_detected_at, now()) END
       WHERE l.id = v_l.id RETURNING * INTO v_l;
    END IF;
  ELSE
    IF v_l.status <> 'needs_review' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_st); END IF;
    IF p_decision = 'choose' THEN
      IF v_ext IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'external_id'); END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_l.candidates, '[]'::jsonb)) x WHERE x ->> 'external_id' = v_ext) THEN
        PERFORM app.fail('MRS_INVALID', 'external_id');
      END IF;
      SELECT l.id INTO v_other FROM public.daftra_client_links l
       WHERE l.org_id = v_l.org_id AND l.external_id = v_ext AND l.status <> 'unlinked' AND l.id <> v_l.id;
      IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
      UPDATE public.daftra_client_links l SET external_id = v_ext, status = 'pending', candidates = NULL, linked_by = auth.uid()
       WHERE l.id = v_l.id RETURNING * INTO v_l;
      v_job := app.bill_enqueue(v_l.org_id, 'client_refresh', NULL, v_l.id, NULL, '{}'::jsonb, auth.uid());
    ELSE
      UPDATE public.daftra_client_links l SET status = 'pending' WHERE l.id = v_l.id RETURNING * INTO v_l;
      v_job := app.bill_enqueue(v_l.org_id, 'client_ensure', NULL, v_l.id, NULL, jsonb_build_object('force_create', true), auth.uid());
    END IF;
  END IF;
  UPDATE public.daftra_client_links l SET review_note = v_note, reviewed_by = auth.uid(), reviewed_at = now() WHERE l.id = v_l.id RETURNING * INTO v_l;
  RETURN jsonb_build_object('link', app.bill_link_json(v_l), 'job', v_job, 'decision', p_decision);
END $$;

-- unlink_daftra_client(p_link, p_reason) — bill_admin; refused while a live intent of the client has a Daftra invoice
CREATE OR REPLACE FUNCTION public.unlink_daftra_client(p_link uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.daftra_client_links; v_reason text; v_from text; v_use uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_l := app.bill_lock_link(p_link, app.bill_admin_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  SELECT i.id INTO v_use FROM public.billing_intents i
   WHERE i.org_id = v_l.org_id AND i.client_id = v_l.client_id AND i.status <> 'cancelled' AND i.external_invoice_id IS NOT NULL LIMIT 1;
  IF v_use IS NOT NULL THEN PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'in_use', v_use::text); END IF;
  IF EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.client_link_id = v_l.id AND j.status IN ('running','unknown')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'sync_in_flight');
  END IF;
  v_from := app.bill_link_status(v_l);
  PERFORM app.bill_cancel_jobs(NULL, v_l.id, NULL);
  UPDATE public.daftra_client_links l SET status = 'unlinked', unlinked_by = auth.uid(), unlinked_at = now(), unlink_reason = v_reason
   WHERE l.id = v_l.id RETURNING * INTO v_l;
  RETURN app.bill_link_json(v_l) || jsonb_build_object('from', v_from);
END $$;

-- ---------------------------------------------------------------------
-- item catalog (step ٤)
-- ---------------------------------------------------------------------
-- list_daftra_items(p_org) → {items: every possible key (mapping or defaults), counts}
CREATE OR REPLACE FUNCTION public.list_daftra_items(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  RETURN (
    WITH k AS (SELECT * FROM app.bill_all_item_keys()),
    x AS (SELECT k.item_key, k.ord,
                 coalesce(app.bill_item_json(i), app.bill_item_defaults(p_org, k.item_key) || jsonb_build_object('mapped', false, 'status', 'unmapped')) j
            FROM k LEFT JOIN public.daftra_item_links i ON i.org_id = p_org AND i.item_key = k.item_key AND i.status <> 'retired')
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(x.j || jsonb_build_object('kind', split_part(x.item_key, ':', 1), 'service_code',
                                                                     nullif(split_part(x.item_key, ':', 2), 'none')) ORDER BY x.ord) FROM x), '[]'::jsonb),
      'counts', coalesce((SELECT jsonb_object_agg(z.s, z.n) FROM (SELECT x.j ->> 'status' s, count(*)::int n FROM x GROUP BY 1) z), '{}'::jsonb),
      'retired', coalesce((SELECT jsonb_agg(app.bill_item_json(i) ORDER BY i.updated_at DESC) FROM public.daftra_item_links i
                            WHERE i.org_id = p_org AND i.status = 'retired'), '[]'::jsonb)));
END $$;

-- save_daftra_item(p_org, p_item_key, {name_ar, name_en, default_vat_rate, tax_code, external_product_id, retire})
CREATE OR REPLACE FUNCTION public.save_daftra_item(p_org uuid, p_item_key text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.daftra_item_links; v_rate numeric; v_tax text; v_ext text; v_other uuid; v_job jsonb; v_from text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF NOT coalesce(app.bill_valid_item_key(p_item_key), false) THEN PERFORM app.fail('MRS_INVALID', 'item_key'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['name_ar','name_en','default_vat_rate','tax_code','external_product_id','retire']);
  IF p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  v_i := app.bill_ensure_item(p_org, p_item_key);
  SELECT * INTO v_i FROM public.daftra_item_links i WHERE i.id = v_i.id FOR UPDATE;
  v_from := v_i.status;
  IF app.pbool(p_payload, 'retire') THEN
    IF EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.item_link_id = v_i.id AND j.status IN ('running','unknown')) THEN
      PERFORM app.fail('MRS_BAD_TRANSITION', 'sync_in_flight');
    END IF;
    PERFORM app.bill_cancel_jobs(NULL, NULL, v_i.id);
    UPDATE public.daftra_item_links i SET status = 'retired', updated_by = auth.uid() WHERE i.id = v_i.id RETURNING * INTO v_i;
    RETURN app.bill_item_json(v_i) || jsonb_build_object('from', v_from);
  END IF;
  IF p_payload ? 'default_vat_rate' THEN
    v_rate := app.pnum(p_payload, 'default_vat_rate', 100);
    IF v_rate IS NULL OR v_rate <> round(v_rate, 2) THEN PERFORM app.fail('MRS_INVALID', 'default_vat_rate'); END IF;
  END IF;
  IF p_payload ? 'tax_code' THEN
    v_tax := app.ptext(p_payload, 'tax_code', 20, true);
    IF NOT app.is_code('daftra_tax_code', v_tax) THEN PERFORM app.fail('MRS_INVALID', 'tax_code'); END IF;
  END IF;
  IF p_payload ? 'external_product_id' THEN
    v_ext := app.ptext(p_payload, 'external_product_id', 64);
    IF v_ext IS NOT NULL AND v_ext !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN PERFORM app.fail('MRS_INVALID', 'external_product_id'); END IF;
    SELECT i.id INTO v_other FROM public.daftra_item_links i
     WHERE i.org_id = p_org AND i.external_product_id = v_ext AND i.status <> 'retired' AND i.id <> v_i.id;
    IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
  END IF;
  UPDATE public.daftra_item_links i SET
    name_ar = CASE WHEN p_payload ? 'name_ar' THEN app.ptext(p_payload, 'name_ar', 160, true) ELSE i.name_ar END,
    name_en = CASE WHEN p_payload ? 'name_en' THEN app.ptext(p_payload, 'name_en', 160) ELSE i.name_en END,
    default_vat_rate = coalesce(v_rate, i.default_vat_rate),
    tax_code = coalesce(v_tax, i.tax_code),
    external_product_id = CASE WHEN p_payload ? 'external_product_id' THEN v_ext ELSE i.external_product_id END,
    status = CASE WHEN p_payload ? 'external_product_id' AND v_ext IS DISTINCT FROM i.external_product_id THEN 'pending' ELSE i.status END,
    candidates = CASE WHEN p_payload ? 'external_product_id' AND v_ext IS DISTINCT FROM i.external_product_id THEN NULL ELSE i.candidates END,
    updated_by = auth.uid()
   WHERE i.id = v_i.id RETURNING * INTO v_i;
  IF char_length(v_i.name_ar) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
  -- a manual product id is verified by the worker (item_ensure); nothing is sent to Daftra from here
  IF p_payload ? 'external_product_id' AND v_i.status = 'pending' THEN
    v_job := app.bill_enqueue(p_org, 'item_ensure', NULL, NULL, v_i.id, '{}'::jsonb, auth.uid());
  END IF;
  RETURN app.bill_item_json(v_i) || jsonb_build_object('from', v_from, 'job', v_job);
END $$;

-- ---------------------------------------------------------------------
-- intents & lines (steps ٥, ٦, ٨)
-- ---------------------------------------------------------------------
-- create_billing_intent({transaction_id, purpose, currency, note, add_eligible}, p_idem_key) → intent + lines
CREATE OR REPLACE FUNCTION public.create_billing_intent(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_txid uuid; v_replay jsonb; v_purpose text; v_cur text; v_key text; v_rev int; v_ref text;
        v_i public.billing_intents; v_other uuid; v_n int; v_lines jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','purpose','currency','note','add_eligible','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles());
  v_replay := app.idem_begin('create_billing_intent', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_tx.client_id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client'); END IF;
  v_purpose := coalesce(app.ptext(p_payload, 'purpose', 20), 'final');
  IF v_purpose NOT IN ('final','interim','supplementary') THEN PERFORM app.fail('MRS_INVALID', 'purpose'); END IF;
  v_cur := coalesce(app.fin_currency(p_payload, 'currency'), 'SAR');
  IF p_payload ? 'add_eligible' AND jsonb_typeof(p_payload -> 'add_eligible') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'add_eligible'); END IF;
  IF v_purpose = 'final' THEN
    SELECT i.id INTO v_other FROM public.billing_intents i
     WHERE i.transaction_id = v_tx.id AND i.currency = v_cur AND i.purpose_key = 'F' AND i.status <> 'cancelled';
    IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'intent_taken', v_other::text); END IF;
    v_key := 'F';
  ELSE
    IF v_purpose = 'supplementary' AND NOT EXISTS (SELECT 1 FROM public.billing_intents i
         WHERE i.transaction_id = v_tx.id AND i.currency = v_cur AND i.purpose = 'final' AND i.status = 'issued') THEN
      PERFORM app.fail('MRS_BAD_TRANSITION', 'no_issued_final');
    END IF;
    IF v_purpose = 'interim' AND EXISTS (SELECT 1 FROM public.billing_intents i
         WHERE i.transaction_id = v_tx.id AND i.currency = v_cur AND i.purpose = 'final' AND i.status = 'issued') THEN
      PERFORM app.fail('MRS_BAD_TRANSITION', 'final_issued');
    END IF;
    SELECT coalesce(max(substr(i.purpose_key, 2)::int), 0) + 1 INTO v_n FROM public.billing_intents i
     WHERE i.transaction_id = v_tx.id AND i.currency = v_cur AND i.purpose = v_purpose AND i.status <> 'cancelled';
    v_key := CASE v_purpose WHEN 'interim' THEN 'I' ELSE 'S' END || v_n::text;
  END IF;
  -- G5-1: at least one approved charge of that currency not yet on a live line
  IF NOT EXISTS (SELECT 1 FROM public.client_charges c WHERE c.transaction_id = v_tx.id AND c.status = 'approved' AND c.currency = v_cur
                    AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = c.id AND l.state <> 'removed')) THEN
    PERFORM app.fail('MRS_REQUIRED', 'lines');
  END IF;
  -- a cancelled intent's reference is never reused: the next one carries -R<n>
  SELECT count(*)::int + 1 INTO v_rev FROM public.billing_intents i
   WHERE i.transaction_id = v_tx.id AND i.currency = v_cur AND i.purpose_key = v_key AND i.status = 'cancelled';
  v_ref := v_tx.ref || '/' || v_key || CASE WHEN v_cur <> 'SAR' THEN '-' || v_cur ELSE '' END || CASE WHEN v_rev > 1 THEN '-R' || v_rev ELSE '' END;
  INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, revision, operational_ref, note, created_by)
  VALUES (v_tx.org_id, v_tx.id, v_tx.client_id, v_purpose, v_key, v_cur, v_rev, v_ref, app.ptext(p_payload, 'note', 2000), auth.uid())
  RETURNING * INTO v_i;
  IF coalesce((p_payload ->> 'add_eligible')::boolean, true) THEN
    v_lines := app.bill_add_lines(v_i, NULL);
    SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = v_i.id;
  END IF;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'intent_created', 'billing_intent', v_i.id,
    jsonb_build_object('purpose', v_i.purpose, 'purpose_key', v_i.purpose_key, 'currency', v_i.currency));
  RETURN app.idem_finish('create_billing_intent', p_idem_key, app.bill_intent_json(v_i) || jsonb_build_object('lines', v_lines));
END $$;

-- add_billing_lines(p_intent, p_charge_ids NULL = all eligible, p_idem_key) → {intent, added}
CREATE OR REPLACE FUNCTION public.add_billing_lines(p_intent uuid, p_charge_ids uuid[] DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_replay jsonb; v_added jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_i := app.bill_lock_intent(p_intent, app.fin_write_roles());
  v_replay := app.idem_begin('add_billing_lines', p_idem_key, jsonb_build_object('intent', p_intent, 'charge_ids', to_jsonb(p_charge_ids)), v_i.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_i.status = 'issued' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'intent_issued'); END IF;
  IF v_i.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  IF p_charge_ids IS NOT NULL AND cardinality(p_charge_ids) = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'lines'); END IF;
  v_added := app.bill_add_lines(v_i, p_charge_ids);
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = v_i.id;
  IF jsonb_array_length(v_added) > 0 THEN
    PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'lines_added', 'billing_intent', v_i.id,
      jsonb_build_object('line_ids', (SELECT jsonb_agg(x -> 'id') FROM jsonb_array_elements(v_added) x),
                         'charge_ids', (SELECT jsonb_agg(x -> 'charge_id') FROM jsonb_array_elements(v_added) x)));
  END IF;
  RETURN app.idem_finish('add_billing_lines', p_idem_key, jsonb_build_object('intent', app.bill_intent_json(v_i), 'added', v_added));
END $$;

-- remove_billing_line(p_line, p_reason): never pushed and nothing in flight → removed; else pending_remove (the worker removes that line_ref only)
CREATE OR REPLACE FUNCTION public.remove_billing_line(p_line uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.billing_intent_lines; v_i public.billing_intents; v_reason text; v_from text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_l FROM public.billing_intent_lines l WHERE l.id = p_line;
  IF v_l.id IS NULL OR NOT app.has_tx_role(v_l.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'line'); END IF;
  v_i := app.bill_lock_intent(v_l.intent_id, app.fin_write_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  IF v_i.status = 'issued' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'intent_issued'); END IF;
  IF v_i.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  SELECT * INTO v_l FROM public.billing_intent_lines l WHERE l.id = p_line FOR UPDATE;
  IF v_l.state NOT IN ('pending_add','synced') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_l.state); END IF;
  v_from := v_l.state;
  -- removed at once only when no write of this intent may have reached Daftra (never pushed, nothing in flight,
  -- no unknown / abandoned attempt left unreconciled); otherwise the worker removes it after its reference lookup
  IF NOT v_l.pushed AND v_i.sync_state NOT IN ('in_flight','unknown')
     AND NOT EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.intent_id = v_i.id AND j.status IN ('running','unknown'))
     AND NOT app.bill_unreconciled(v_i.id) THEN
    UPDATE public.billing_intent_lines l SET state = 'removed', removed_reason = v_reason, removed_by = auth.uid(), removed_at = now()
     WHERE l.id = v_l.id RETURNING * INTO v_l;
  ELSE
    UPDATE public.billing_intent_lines l SET state = 'pending_remove', removed_reason = v_reason, removed_by = auth.uid()
     WHERE l.id = v_l.id RETURNING * INTO v_l;
    PERFORM app.bill_local_change(v_i.id);
  END IF;
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = v_i.id;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'line_removed', 'billing_intent_line', v_l.id,
    jsonb_build_object('intent_id', v_i.id, 'charge_id', v_l.charge_id, 'state', v_l.state));
  RETURN app.bill_line_json(v_l) || jsonb_build_object('from', v_from, 'intent', app.bill_intent_json(v_i));
END $$;

-- request_billing_push(p_intent, p_idem_key) → {intent, job, deduplicated}
CREATE OR REPLACE FUNCTION public.request_billing_push(p_intent uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_replay jsonb; v_block text; v_conn public.daftra_connections; v_bad text; v_link public.daftra_client_links;
        v_job jsonb; k text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_i := app.bill_lock_intent(p_intent, app.fin_write_roles());
  v_replay := app.idem_begin('request_billing_push', p_idem_key, jsonb_build_object('intent', p_intent), v_i.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_i.status = 'issued' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'intent_issued'); END IF;
  IF v_i.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  IF v_i.sync_state = 'conflict' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'conflict_open'); END IF;
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_i.org_id;
  v_block := app.bill_conn_block(v_i.org_id);
  IF v_block = 'not_connected' THEN
    PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'not_connected', CASE WHEN v_conn.status = 'connected' THEN 'sync_disabled' ELSE coalesce(v_conn.status, 'not_connected') END);
  ELSIF v_block = 'capability' THEN
    PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'capability', array_to_string(app.bill_missing_caps(v_conn.capabilities), ','));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced')) THEN
    PERFORM app.fail('MRS_REQUIRED', 'lines');
  END IF;
  SELECT string_agg(l.line_ref, ',' ORDER BY l.line_ref) INTO v_bad FROM public.billing_intent_lines l
   WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced') AND NOT (l.vat_rate = ANY (v_conn.allowed_vat_rates));
  IF v_bad IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'tax_rate_unmapped', v_bad); END IF;
  v_link := app.bill_ensure_client_link(v_i.org_id, v_i.client_id);
  IF v_link.status = 'needs_review' THEN PERFORM app.fin_fail('MRS_REQUIRED', 'client_review', v_link.id::text); END IF;
  FOR k IN SELECT DISTINCT l.item_key FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed' LOOP
    IF (app.bill_ensure_item(v_i.org_id, k)).status = 'needs_review' THEN PERFORM app.fin_fail('MRS_REQUIRED', 'item_review', k); END IF;
  END LOOP;
  v_job := app.bill_enqueue(v_i.org_id, 'invoice_push', v_i.id, NULL, NULL, '{}'::jsonb, auth.uid());
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

-- request_billing_pull(p_intent) → job
CREATE OR REPLACE FUNCTION public.request_billing_pull(p_intent uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_i := app.bill_lock_intent(p_intent, app.fin_write_roles());
  IF v_i.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  IF v_i.external_invoice_id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'external_invoice_id'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.daftra_connections c WHERE c.org_id = v_i.org_id AND c.status = 'connected' AND c.sync_enabled) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'not_connected');
  END IF;
  RETURN app.bill_enqueue(v_i.org_id, 'invoice_pull', v_i.id, NULL, NULL, '{}'::jsonb, auth.uid());
END $$;

-- resolve_billing_conflict(p_intent, keep_remote | overwrite_remote | recreate | release, p_note)
CREATE OR REPLACE FUNCTION public.resolve_billing_conflict(p_intent uuid, p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_note text; v_reason text; v_job jsonb; v_l public.billing_intent_lines; v_ov jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_i := app.bill_lock_intent(p_intent, app.fin_approve_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('keep_remote','overwrite_remote','recreate','release') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.fin_note(p_note, 'note');
  IF v_i.sync_state <> 'conflict' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'no_conflict'); END IF;
  IF v_i.status IN ('issued','cancelled') THEN PERFORM app.fail('MRS_BAD_TRANSITION', CASE v_i.status WHEN 'issued' THEN 'intent_issued' ELSE 'cancelled' END); END IF;
  v_reason := coalesce(v_i.conflict ->> 'reason', 'remote_edited');
  IF (p_decision IN ('keep_remote','overwrite_remote') AND v_reason <> 'remote_edited')
     OR (p_decision = 'recreate' AND v_reason <> 'remote_missing')
     OR (p_decision = 'release' AND v_reason NOT IN ('remote_missing','external_in_use')) THEN
    PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'conflict_reason', v_reason);
  END IF;
  IF p_decision = 'keep_remote' THEN
    -- accept the accountant's edits: owned lines keep the remote values as an override note; nothing is sent
    FOR v_l IN SELECT * FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed' ORDER BY l.id FOR UPDATE LOOP
      SELECT jsonb_object_agg(d ->> 'field', d -> 'remote') INTO v_ov
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_i.conflict -> 'diff') = 'array' THEN v_i.conflict -> 'diff' ELSE '[]'::jsonb END) d
       WHERE d ->> 'line_ref' = v_l.line_ref AND d ? 'field';
      IF v_ov IS NOT NULL THEN
        UPDATE public.billing_intent_lines l SET remote_override = coalesce(l.remote_override, '{}'::jsonb) || v_ov WHERE l.id = v_l.id;
      END IF;
    END LOOP;
    UPDATE public.billing_intents i SET pushed_hash = coalesce(i.remote_hash, i.pushed_hash), conflict = NULL,
           sync_state = CASE WHEN EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.intent_id = i.id AND l.state IN ('pending_add','pending_remove'))
                             THEN 'pending' ELSE 'synced' END
     WHERE i.id = v_i.id RETURNING * INTO v_i;
  ELSIF p_decision = 'overwrite_remote' THEN
    v_job := app.bill_enqueue(v_i.org_id, 'invoice_push', v_i.id, NULL, NULL, jsonb_build_object('overwrite', true), auth.uid());
    UPDATE public.billing_intents i SET sync_state = 'pending' WHERE i.id = v_i.id RETURNING * INTO v_i;
  ELSIF p_decision = 'recreate' THEN
    -- the remote draft is gone: lines waiting for removal are simply removed; the worker still searches by reference first
    UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now() WHERE l.intent_id = v_i.id AND l.state = 'pending_remove';
    UPDATE public.billing_intents i SET external_invoice_id = NULL, daftra_number = NULL, daftra_status = NULL, remote_version = NULL,
           pushed_hash = NULL, remote_hash = NULL, remote_net = NULL, remote_vat = NULL, remote_total = NULL, status = 'open',
           conflict = NULL, sync_state = 'pending'
     WHERE i.id = v_i.id RETURNING * INTO v_i;
    v_job := app.bill_enqueue(v_i.org_id, 'invoice_push', v_i.id, NULL, NULL, jsonb_build_object('recreate', true), auth.uid());
  ELSE
    v_i := app.bill_release(v_i, v_note, 'released');
    PERFORM app.bill_tx_financial(v_i.transaction_id);
  END IF;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'conflict_resolved', 'billing_intent', v_i.id,
    jsonb_build_object('decision', p_decision, 'reason', v_reason, 'job_id', v_job -> 'id'));
  RETURN app.bill_intent_json(v_i) || jsonb_build_object('job', v_job, 'decision', p_decision);
END $$;

-- cancel_billing_intent(p_intent, p_reason) — open intents with no remote draft only
CREATE OR REPLACE FUNCTION public.cancel_billing_intent(p_intent uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_reason text; v_from text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_i := app.bill_lock_intent(p_intent, app.fin_approve_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  IF v_i.status = 'issued' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'intent_issued'); END IF;
  IF v_i.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  IF v_i.sync_state IN ('in_flight','unknown')
     OR EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.intent_id = v_i.id AND j.status IN ('running','unknown')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'sync_in_flight');
  END IF;
  IF v_i.external_invoice_id IS NOT NULL OR v_i.status = 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'remote_draft_exists'); END IF;
  IF v_i.sync_state = 'conflict' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'conflict_open'); END IF;
  -- a create may have reached Daftra (lost response, crashed worker) and was never reconciled: retry the job first
  -- (its reference lookup settles it); cancelling now could bill the same charges on a second invoice
  IF app.bill_unreconciled(v_i.id) THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'unreconciled_remote'); END IF;
  v_from := v_i.status;
  v_i := app.bill_release(v_i, v_reason, 'intent_cancelled');
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'intent_cancelled', 'billing_intent', v_i.id, '{}'::jsonb);
  RETURN app.bill_intent_json(v_i) || jsonb_build_object('from', v_from);
END $$;

-- retry_billing_job(p_job) — failed | dead → queued (max_attempts = attempts + 3)
CREATE OR REPLACE FUNCTION public.retry_billing_job(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_j public.billing_sync_jobs; v_i public.billing_intents; v_live public.billing_sync_jobs;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = p_job;
  IF v_j.id IS NULL OR NOT app.bill_can_read_job(v_j) THEN PERFORM app.fail('MRS_NOT_FOUND', 'job'); END IF;
  IF v_j.intent_id IS NOT NULL THEN
    v_i := app.bill_lock_intent(v_j.intent_id, app.fin_write_roles());
  ELSIF NOT app.has_role(v_j.org_id, app.fin_write_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  -- the probe (connection state) and the item catalog are bill_admin (G5-4), like request_daftra_probe / save_daftra_item
  IF v_j.kind IN ('probe','item_ensure') AND NOT app.has_role(v_j.org_id, app.bill_admin_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = p_job FOR UPDATE;
  IF v_j.status NOT IN ('failed','dead') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_j.status); END IF;
  IF v_i.status IN ('issued','cancelled') AND v_j.kind = 'invoice_push' THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', CASE v_i.status WHEN 'issued' THEN 'intent_issued' ELSE 'cancelled' END);
  END IF;
  SELECT * INTO v_live FROM public.billing_sync_jobs j
   WHERE j.org_id = v_j.org_id AND j.dedupe_key = v_j.dedupe_key AND j.status IN ('queued','running','unknown');
  IF v_live.id IS NOT NULL THEN RETURN app.bill_job_json(v_live) || jsonb_build_object('deduplicated', true); END IF;
  UPDATE public.billing_sync_jobs j SET status = 'queued', max_attempts = j.attempts + 3, next_run_at = now(), finished_at = NULL,
         locked_by = NULL, locked_until = NULL, requested_by = auth.uid()
   WHERE j.id = v_j.id RETURNING * INTO v_j;
  IF v_i.id IS NOT NULL AND v_j.kind = 'invoice_push' THEN
    UPDATE public.billing_intents i SET sync_state = 'pending' WHERE i.id = v_i.id AND i.sync_state = 'error';
  END IF;
  RETURN app.bill_job_json(v_j) || jsonb_build_object('deduplicated', false, 'from', 'failed');
END $$;

-- ---------------------------------------------------------------------
-- readers
-- ---------------------------------------------------------------------
-- list_billing_intents(p_org, {status, sync_state, transaction_id, client_id, branch_id, payment_status, q, limit, offset})
CREATE OR REPLACE FUNCTION public.list_billing_intents(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_st text; v_ss text; v_tx uuid; v_cl uuid; v_br uuid; v_ps text; v_q text;
        v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['status','sync_state','transaction_id','client_id','branch_id','payment_status','q','limit','offset']);
  v_st := app.ptext(f, 'status', 20); v_ss := app.ptext(f, 'sync_state', 20); v_ps := app.ptext(f, 'payment_status', 20);
  v_tx := app.puuid(f, 'transaction_id'); v_cl := app.puuid(f, 'client_id'); v_br := app.puuid(f, 'branch_id');
  v_q := app.ptext(f, 'q', 80);
  v_limit := least(coalesce(app.pnum(f, 'limit', 1000000)::int, 50), 200);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000000)::int, 0);
  RETURN (
    WITH base AS (
      SELECT i.*, t.ref AS tx_ref, t.branch_id AS tx_branch, c.name_ar AS client_name
        FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id JOIN public.clients c ON c.id = i.client_id
       WHERE i.org_id = p_org AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
         AND (v_tx IS NULL OR i.transaction_id = v_tx) AND (v_cl IS NULL OR i.client_id = v_cl) AND (v_br IS NULL OR t.branch_id = v_br)
         AND (v_q IS NULL OR t.ref ILIKE '%' || v_q || '%' OR i.operational_ref ILIKE '%' || v_q || '%'
              OR coalesce(i.daftra_number, '') ILIKE '%' || v_q || '%' OR c.name_ar ILIKE '%' || v_q || '%')),
    filtered AS (SELECT * FROM base b WHERE (v_st IS NULL OR b.status = v_st) AND (v_ss IS NULL OR b.sync_state = v_ss)
                                          AND (v_ps IS NULL OR b.payment_status = v_ps))
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(app.bill_intent_json(i) ORDER BY i.created_at DESC, i.id)
                           FROM public.billing_intents i
                          WHERE i.id IN (SELECT x.id FROM filtered x ORDER BY x.created_at DESC, x.id LIMIT v_limit OFFSET v_offset)), '[]'::jsonb),
      'total', (SELECT count(*)::int FROM filtered),
      'counts', jsonb_build_object(
        'by_status', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT b.status k, count(*)::int n FROM base b GROUP BY 1) z), '{}'::jsonb),
        'by_sync_state', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT b.sync_state k, count(*)::int n FROM base b GROUP BY 1) z), '{}'::jsonb),
        'by_payment_status', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT b.payment_status k, count(*)::int n FROM base b GROUP BY 1) z), '{}'::jsonb))));
END $$;

-- eligible approved charges of a transaction (optionally one currency) not on a live line
CREATE OR REPLACE FUNCTION app.bill_eligible(p_tx uuid, p_cur text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(app.fin_charge_json(c) || jsonb_build_object('item_key', app.bill_item_key(c.kind, c.service_code))
                            ORDER BY c.created_at, c.id), '[]'::jsonb)
    FROM public.client_charges c
   WHERE c.transaction_id = p_tx AND c.status = 'approved' AND (p_cur IS NULL OR c.currency = p_cur)
     AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = c.id AND l.state <> 'removed')
     AND NOT app.bill_charge_held(c.transaction_id, c.id)
$$;

CREATE OR REPLACE FUNCTION app.bill_review_json(r public.billing_review_items) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(r) || jsonb_build_object(
    'transaction_ref', t.ref, 'branch_id', t.branch_id,
    'operational_ref', (SELECT i.operational_ref FROM public.billing_intents i WHERE i.id = r.intent_id),
    'charge', (SELECT jsonb_build_object('id', c.id, 'description', c.description, 'kind', c.kind, 'currency', c.currency,
                                         'total_amount', c.total_amount, 'status', c.status)
                 FROM public.client_charges c WHERE c.id = r.charge_id))
    FROM public.transactions t WHERE t.id = r.transaction_id
$$;

-- get_billing_intent(p_id) → {intent, transaction, client, lines, eligible_charges, jobs, review_items, checks, can}
CREATE OR REPLACE FUNCTION public.get_billing_intent(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_tx public.transactions; v_link public.daftra_client_links; v_conn public.daftra_connections;
        v_w boolean; v_a boolean; v_block text; v_live int; v_checks jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = p_id;
  IF v_i.id IS NULL OR NOT app.has_tx_role(v_i.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'intent'); END IF;
  v_tx := app.fin_tx_read(v_i.transaction_id);
  SELECT * INTO v_link FROM public.daftra_client_links l WHERE l.org_id = v_i.org_id AND l.client_id = v_i.client_id AND l.status <> 'unlinked';
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_i.org_id;
  v_w := app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.fin_write_roles());
  v_a := app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.fin_approve_roles());
  v_block := app.bill_conn_block(v_i.org_id);
  SELECT count(*)::int INTO v_live FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced');
  v_checks := jsonb_build_object(
    'client_link', CASE WHEN v_link.id IS NULL THEN 'missing' ELSE app.bill_link_status(v_link) END,
    'items_unmapped', coalesce((SELECT jsonb_agg(DISTINCT l.item_key) FROM public.billing_intent_lines l
                                 WHERE l.intent_id = v_i.id AND l.state <> 'removed'
                                   AND NOT EXISTS (SELECT 1 FROM public.daftra_item_links d WHERE d.org_id = v_i.org_id AND d.item_key = l.item_key
                                                     AND d.status = 'linked')), '[]'::jsonb),
    'tax_rate_unmapped', coalesce((SELECT jsonb_agg(l.line_ref ORDER BY l.line_ref) FROM public.billing_intent_lines l
                                    WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced')
                                      AND NOT (l.vat_rate = ANY (coalesce(v_conn.allowed_vat_rates, '{0,15}'::numeric[])))), '[]'::jsonb),
    'reimbursable_taxed', coalesce((SELECT jsonb_agg(l.line_ref ORDER BY l.line_ref) FROM public.billing_intent_lines l
                                     WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced') AND l.kind = 'reimbursable' AND l.vat_rate > 0), '[]'::jsonb),
    'other_currency', coalesce((SELECT jsonb_agg(jsonb_build_object('charge_id', c.id, 'currency', c.currency) ORDER BY c.currency, c.created_at)
                                  FROM public.client_charges c WHERE c.transaction_id = v_i.transaction_id AND c.status = 'approved' AND c.currency <> v_i.currency
                                   AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = c.id AND l.state <> 'removed')), '[]'::jsonb),
    'capabilities_missing', to_jsonb(app.bill_missing_caps(coalesce(v_conn.capabilities, '{}'::jsonb))));
  RETURN jsonb_build_object(
    'intent', app.bill_intent_json(v_i),
    'transaction', jsonb_build_object('id', v_tx.id, 'ref', v_tx.ref, 'branch_id', v_tx.branch_id,
                                      'operational_status', v_tx.operational_status, 'financial_status', v_tx.financial_status),
    'client', (SELECT jsonb_build_object('id', c.id, 'name_ar', c.name_ar, 'name_en', c.name_en, 'vat_number', c.vat_number,
                                         'link', CASE WHEN v_link.id IS NOT NULL THEN app.bill_link_json(v_link) END)
                 FROM public.clients c WHERE c.id = v_i.client_id),
    'lines', coalesce((SELECT jsonb_agg(app.bill_line_json(l) ORDER BY l.created_at, l.id) FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id), '[]'::jsonb),
    'eligible_charges', CASE WHEN v_i.status IN ('open','draft') THEN app.bill_eligible(v_i.transaction_id, v_i.currency) ELSE '[]'::jsonb END,
    'jobs', coalesce((SELECT jsonb_agg(app.bill_job_json(j) ORDER BY j.created_at DESC)
                        FROM (SELECT * FROM public.billing_sync_jobs j WHERE j.intent_id = v_i.id ORDER BY j.created_at DESC LIMIT 10) j), '[]'::jsonb),
    'review_items', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at) FROM public.billing_review_items r
                               WHERE r.intent_id = v_i.id OR r.resolved_intent_id = v_i.id), '[]'::jsonb),
    'checks', v_checks,
    'connection', jsonb_build_object('status', coalesce(v_conn.status, 'not_connected'), 'mode', coalesce(v_conn.mode, 'mock'),
                                     'sync_enabled', coalesce(v_conn.sync_enabled, false)),
    'can', jsonb_build_object(
      'edit', v_w AND v_i.status IN ('open','draft'),
      'push', v_w AND v_i.status IN ('open','draft') AND v_i.sync_state <> 'conflict' AND v_block IS NULL AND v_live > 0
              AND jsonb_array_length(v_checks -> 'tax_rate_unmapped') = 0 AND v_checks ->> 'client_link' <> 'needs_review',
      'pull', v_w AND v_i.external_invoice_id IS NOT NULL AND v_i.status <> 'cancelled',
      'resolve', v_a AND v_i.sync_state = 'conflict' AND v_i.status IN ('open','draft'),
      'cancel', v_a AND v_i.status = 'open' AND v_i.external_invoice_id IS NULL AND v_i.sync_state NOT IN ('in_flight','unknown','conflict')
                AND NOT app.bill_unreconciled(v_i.id),
      'push_blocked_by', CASE WHEN v_i.status = 'issued' THEN 'intent_issued' WHEN v_i.status = 'cancelled' THEN 'cancelled'
                              WHEN v_i.sync_state = 'conflict' THEN 'conflict_open' WHEN v_block IS NOT NULL THEN v_block
                              WHEN v_live = 0 THEN 'lines'
                              WHEN jsonb_array_length(v_checks -> 'tax_rate_unmapped') > 0 THEN 'tax_rate_unmapped'
                              WHEN v_checks ->> 'client_link' = 'needs_review' THEN 'client_review'
                              WHEN NOT v_w THEN 'role' END));
END $$;

-- list_billing_jobs(p_org, {status, kind, intent_id, limit, offset})
CREATE OR REPLACE FUNCTION public.list_billing_jobs(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_st text; v_kind text; v_int uuid; v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['status','kind','intent_id','limit','offset']);
  v_st := app.ptext(f, 'status', 20); v_kind := app.ptext(f, 'kind', 20); v_int := app.puuid(f, 'intent_id');
  v_limit := least(coalesce(app.pnum(f, 'limit', 1000000)::int, 50), 200);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000000)::int, 0);
  RETURN (
    WITH base AS (SELECT j.* FROM public.billing_sync_jobs j WHERE j.org_id = p_org AND app.bill_can_read_job(j)
                    AND (v_kind IS NULL OR j.kind = v_kind) AND (v_int IS NULL OR j.intent_id = v_int)),
    filtered AS (SELECT * FROM base b WHERE v_st IS NULL OR b.status = v_st)
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(app.bill_job_json(j) ORDER BY j.created_at DESC, j.id)
                           FROM public.billing_sync_jobs j
                          WHERE j.id IN (SELECT x.id FROM filtered x ORDER BY x.created_at DESC, x.id LIMIT v_limit OFFSET v_offset)), '[]'::jsonb),
      'total', (SELECT count(*)::int FROM filtered),
      'counts', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT b.status k, count(*)::int n FROM base b GROUP BY 1) z), '{}'::jsonb)));
END $$;

-- get_billing_job(p_id) → {job, attempts (redacted calls)}
CREATE OR REPLACE FUNCTION public.get_billing_job(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_j public.billing_sync_jobs;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = p_id;
  IF v_j.id IS NULL OR NOT app.bill_can_read_job(v_j) THEN PERFORM app.fail('MRS_NOT_FOUND', 'job'); END IF;
  RETURN jsonb_build_object('job', app.bill_job_json(v_j),
    'attempts', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attempt_no) FROM public.billing_sync_attempts a WHERE a.job_id = v_j.id), '[]'::jsonb));
END $$;

-- billing_review_queue(p_org, {branch_id, kind})
CREATE OR REPLACE FUNCTION public.billing_review_queue(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_kind text; v_r jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['branch_id','kind']);
  v_br := app.puuid(f, 'branch_id'); v_kind := app.ptext(f, 'kind', 40);
  WITH ri AS (SELECT r.* FROM public.billing_review_items r JOIN public.transactions t ON t.id = r.transaction_id
               WHERE r.org_id = p_org AND r.status = 'open' AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
                 AND (v_br IS NULL OR t.branch_id = v_br) AND (v_kind IS NULL OR r.kind = v_kind)),
       it AS (SELECT i.* FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id
               WHERE i.org_id = p_org AND i.status IN ('open','draft') AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
                 AND (v_br IS NULL OR t.branch_id = v_br))
  SELECT jsonb_build_object(
    'late_charges', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at) FROM ri r WHERE r.kind = 'late_charge'), '[]'::jsonb),
    'issued_mismatch', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at) FROM ri r WHERE r.kind = 'issued_mismatch'), '[]'::jsonb),
    'issued_cancelled', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at) FROM ri r WHERE r.kind = 'issued_cancelled'), '[]'::jsonb),
    'conflicts', coalesce((SELECT jsonb_agg(app.bill_intent_json(i) ORDER BY i.updated_at) FROM it i WHERE i.sync_state = 'conflict'), '[]'::jsonb),
    'unknown', coalesce((SELECT jsonb_agg(app.bill_intent_json(i) ORDER BY i.updated_at) FROM it i WHERE i.sync_state = 'unknown'), '[]'::jsonb),
    'failed_jobs', coalesce((SELECT jsonb_agg(app.bill_job_json(j) ORDER BY j.updated_at DESC) FROM public.billing_sync_jobs j
                              WHERE j.org_id = p_org AND j.status IN ('failed','dead') AND app.bill_can_read_job(j)
                                AND (v_br IS NULL OR j.intent_id IS NULL OR EXISTS (SELECT 1 FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id
                                                                                    WHERE i.id = j.intent_id AND t.branch_id = v_br))), '[]'::jsonb),
    'client_drift', coalesce((SELECT jsonb_agg(app.bill_link_json(l) ORDER BY l.updated_at) FROM public.daftra_client_links l
                               WHERE l.org_id = p_org AND app.bill_link_status(l) = 'drift'), '[]'::jsonb),
    'client_review', coalesce((SELECT jsonb_agg(app.bill_link_json(l) ORDER BY l.updated_at) FROM public.daftra_client_links l
                                WHERE l.org_id = p_org AND l.status IN ('needs_review','error')), '[]'::jsonb),
    'item_review', coalesce((SELECT jsonb_agg(app.bill_item_json(d) ORDER BY d.updated_at) FROM public.daftra_item_links d
                              WHERE d.org_id = p_org AND d.status IN ('needs_review','error')), '[]'::jsonb))
    INTO v_r;
  RETURN v_r || jsonb_build_object('counts', (SELECT jsonb_object_agg(e.key, jsonb_array_length(e.value)) FROM jsonb_each(v_r) e));
END $$;

-- resolve_billing_review(p_id, p_decision, p_note, p_intent)
CREATE OR REPLACE FUNCTION public.resolve_billing_review(p_id uuid, p_decision text, p_note text, p_intent uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_r public.billing_review_items; v_note text; v_i public.billing_intents; v_t public.billing_intents; v_l public.billing_intent_lines;
        v_ov jsonb; v_added jsonb; v_status text := 'resolved';
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_r FROM public.billing_review_items r WHERE r.id = p_id;
  IF v_r.id IS NULL OR NOT app.has_tx_role(v_r.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'review_item'); END IF;
  PERFORM app.g3_lock_tx(v_r.transaction_id, app.fin_approve_roles());
  v_note := app.fin_note(p_note, 'note');
  IF NOT ((v_r.kind = 'late_charge' AND p_decision IN ('supplementary','dismiss'))
          OR (v_r.kind = 'issued_mismatch' AND p_decision IN ('accept','credit_note_in_daftra'))
          OR (v_r.kind = 'issued_cancelled' AND p_decision IN ('release_charges','dismiss'))) THEN
    PERFORM app.fail('MRS_INVALID', 'decision');
  END IF;
  IF v_r.intent_id IS NOT NULL THEN SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = v_r.intent_id FOR UPDATE; END IF;
  SELECT * INTO v_r FROM public.billing_review_items r WHERE r.id = p_id FOR UPDATE;
  IF v_r.status <> 'open' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_r.status); END IF;
  IF p_decision = 'supplementary' THEN
    IF p_intent IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'intent'); END IF;
    SELECT * INTO v_t FROM public.billing_intents i WHERE i.id = p_intent FOR UPDATE;
    IF v_t.id IS NULL OR v_t.transaction_id <> v_r.transaction_id OR v_t.purpose <> 'supplementary' OR v_t.status NOT IN ('open','draft')
       OR v_t.currency <> (SELECT c.currency FROM public.client_charges c WHERE c.id = v_r.charge_id) THEN
      PERFORM app.fail('MRS_INVALID', 'intent');
    END IF;
    UPDATE public.billing_review_items r SET status = 'resolved', resolution = 'supplementary', resolution_note = v_note,
           resolved_intent_id = v_t.id, resolved_by = auth.uid(), resolved_at = now() WHERE r.id = v_r.id RETURNING * INTO v_r;
    v_added := app.bill_add_lines(v_t, ARRAY[v_r.charge_id]);
  ELSIF p_decision = 'dismiss' THEN
    v_status := 'dismissed';
  ELSIF p_decision = 'accept' THEN
    -- Daftra is the truth: owned lines keep the remote values as an override note
    FOR v_l IN SELECT * FROM public.billing_intent_lines l WHERE l.intent_id = v_r.intent_id AND l.state <> 'removed' ORDER BY l.id FOR UPDATE LOOP
      SELECT jsonb_object_agg(d ->> 'field', d -> 'remote') INTO v_ov
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_r.details -> 'diff') = 'array' THEN v_r.details -> 'diff' ELSE '[]'::jsonb END) d
       WHERE d ->> 'line_ref' = v_l.line_ref AND d ? 'field';
      IF v_ov IS NOT NULL THEN
        UPDATE public.billing_intent_lines l SET remote_override = coalesce(l.remote_override, '{}'::jsonb) || v_ov WHERE l.id = v_l.id;
      END IF;
    END LOOP;
    -- lines removed in Marsa but present on the issued invoice: Daftra billed them, so their charges are invoiced
    PERFORM app.bill_set_charges(ARRAY(SELECT (x ->> 'charge_id')::uuid
                                         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_r.details -> 'removed_on_remote') = 'array'
                                                                        THEN v_r.details -> 'removed_on_remote' ELSE '[]'::jsonb END) x
                                        WHERE x ->> 'charge_id' ~ '^[0-9a-f-]{36}$'
                                          AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines o
                                                           WHERE o.charge_id = (x ->> 'charge_id')::uuid AND o.state <> 'removed')), 'invoiced');
  ELSIF p_decision = 'release_charges' THEN
    IF v_i.status <> 'issued' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_i.status); END IF;
    v_i := app.bill_release(v_i, v_note, 'released');
    PERFORM app.bill_tx_financial(v_i.transaction_id);
  END IF;
  IF v_r.status = 'open' THEN
    UPDATE public.billing_review_items r SET status = v_status, resolution = p_decision, resolution_note = v_note,
           resolved_by = auth.uid(), resolved_at = now() WHERE r.id = v_r.id RETURNING * INTO v_r;
  END IF;
  PERFORM app.bill_event(v_r.org_id, v_r.transaction_id, 'review_resolved', 'billing_review_item', v_r.id,
    jsonb_build_object('kind', v_r.kind, 'decision', p_decision, 'intent_id', v_r.intent_id, 'charge_id', v_r.charge_id,
                       'resolved_intent_id', v_r.resolved_intent_id));
  RETURN app.bill_review_json(v_r) || jsonb_build_object('added', v_added);
END $$;

-- tx_billing(p_tx) → {intents (+ lines), eligible_charges, review_items, financial_status, connection}
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
                           'job_status', (SELECT j.status FROM public.billing_sync_jobs j WHERE j.intent_id = i.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1))
                           ORDER BY i.created_at) FROM public.billing_intents i WHERE i.transaction_id = v_tx.id), '[]'::jsonb),
    'eligible_charges', app.bill_eligible(v_tx.id, NULL),
    'review_items', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at) FROM public.billing_review_items r
                               WHERE r.transaction_id = v_tx.id), '[]'::jsonb),
    'financial_status', v_tx.financial_status,
    'connection', jsonb_build_object('status', coalesce(v_conn.status, 'not_connected'), 'mode', coalesce(v_conn.mode, 'mock'),
                                     'sync_enabled', coalesce(v_conn.sync_enabled, false)),
    'can', jsonb_build_object('write', app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.fin_write_roles()),
                              'approve', app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.fin_approve_roles())));
END $$;

-- =====================================================================
-- worker RPCs (service_role only) — contract: docs/online/G5_SPEC.md § Worker RPC contract
-- =====================================================================

-- ---------------------------------------------------------------------
-- context builders (the worker's only input)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bill_ctx_client(l public.daftra_client_links) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('link_id', l.id, 'client_id', l.client_id, 'client_ref', l.client_ref, 'external_id', l.external_id,
                            'status', app.bill_link_status(l), 'data', app.bill_client_snapshot(c), 'pushed_snapshot', l.pushed_snapshot)
    FROM public.clients c WHERE c.id = l.client_id
$$;

CREATE OR REPLACE FUNCTION app.bill_ctx_item(i public.daftra_item_links) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('link_id', i.id, 'item_key', i.item_key, 'product_code', i.product_code,
                            'external_product_id', i.external_product_id, 'name_ar', i.name_ar, 'name_en', i.name_en,
                            'default_vat_rate', i.default_vat_rate, 'tax_code', i.tax_code, 'status', i.status)
$$;

CREATE OR REPLACE FUNCTION app.bill_job_context(j public.billing_sync_jobs, p_attempt uuid, p_prev text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ctx jsonb; v_conn jsonb := app.bill_conn_json(j.org_id); v_l public.daftra_client_links; v_it public.daftra_item_links;
        v_i public.billing_intents; v_t public.transactions; v_items jsonb := '[]'::jsonb; k text;
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
                                                                    'invoice_notes', v_conn -> 'invoice_notes')));
  IF j.client_link_id IS NOT NULL THEN
    SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.id = j.client_link_id;
    v_ctx := v_ctx || jsonb_build_object('client', app.bill_ctx_client(v_l));
  ELSIF j.item_link_id IS NOT NULL THEN
    SELECT * INTO v_it FROM public.daftra_item_links i WHERE i.id = j.item_link_id;
    v_ctx := v_ctx || jsonb_build_object('item', app.bill_ctx_item(v_it));
  ELSIF j.intent_id IS NOT NULL THEN
    SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = j.intent_id;
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = v_i.transaction_id;
    v_l := app.bill_ensure_client_link(v_i.org_id, v_i.client_id);
    FOR k IN SELECT DISTINCT l.item_key FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed' ORDER BY 1 LOOP
      v_items := v_items || jsonb_build_array(app.bill_ctx_item(app.bill_ensure_item(v_i.org_id, k)));
    END LOOP;
    v_ctx := v_ctx || jsonb_build_object('intent', jsonb_build_object(
      'id', v_i.id, 'transaction_id', v_i.transaction_id, 'transaction_ref', v_t.ref, 'operational_ref', v_i.operational_ref,
      'currency', v_i.currency, 'purpose', v_i.purpose, 'status', v_i.status, 'sync_state', v_i.sync_state,
      'external_invoice_id', v_i.external_invoice_id, 'pushed_hash', v_i.pushed_hash, 'remote_version', v_i.remote_version,
      'invoice_date', to_char(current_date, 'YYYY-MM-DD'), 'notes', v_conn -> 'invoice_notes',
      'client', app.bill_ctx_client(v_l), 'items', v_items,
      'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('line_id', l.id, 'line_ref', l.line_ref, 'state', l.state, 'pushed', l.pushed,
                                                             'remote_line_id', l.remote_line_id, 'item_key', l.item_key, 'description', l.description,
                                                             'quantity', l.quantity, 'unit_price', l.unit_price, 'vat_rate', l.vat_rate,
                                                             'net_amount', l.net_amount, 'vat_amount', l.vat_amount, 'total_amount', l.total_amount)
                                          ORDER BY l.line_ref)
                           FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed'), '[]'::jsonb)));
  END IF;
  RETURN v_ctx;
END $$;

-- daftra_claim_jobs(p_worker, p_limit) → [context]
--   due queued / unknown jobs, or running jobs whose lease expired (their open attempt → abandoned, treated as unknown);
--   at most one job per org per call, never an org with a live lease, never an org with sync disabled (probe excepted)
CREATE OR REPLACE FUNCTION public.daftra_claim_jobs(p_worker text, p_limit int DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_j public.billing_sync_jobs; v_orgs uuid[] := '{}'; v_out jsonb := '[]'::jsonb; v_prev text; v_att uuid; v_mode text;
        v_worker text := nullif(btrim(coalesce(p_worker, '')), '');
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
    -- one lane per org across concurrent claimers (released at commit)
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('marsa.daftra.lane:' || v_j.org_id::text, 0));
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
    END IF;
    SELECT c.mode INTO v_mode FROM public.daftra_connections c WHERE c.org_id = v_j.org_id;
    UPDATE public.billing_sync_jobs j SET status = 'running', attempts = j.attempts + 1, locked_by = v_worker,
           locked_until = now() + interval '5 minutes', finished_at = NULL
     WHERE j.id = v_j.id RETURNING * INTO v_j;
    INSERT INTO public.billing_sync_attempts (org_id, job_id, attempt_no, worker, adapter_mode)
    VALUES (v_j.org_id, v_j.id, v_j.attempts, v_worker, CASE WHEN coalesce(v_mode, 'mock') = 'mock' THEN 'mock' ELSE 'live' END)
    RETURNING id INTO v_att;
    IF v_j.kind = 'invoice_push' THEN
      UPDATE public.billing_intents i SET sync_state = 'in_flight' WHERE i.id = v_j.intent_id AND i.status IN ('open','draft');
    END IF;
    v_out := v_out || jsonb_build_array(app.bill_job_context(v_j, v_att, v_prev));
  END LOOP;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------
-- completion helpers
-- ---------------------------------------------------------------------
-- calls log: array, ≤ 50 entries, redacted, ≤ 256 KiB (bodies dropped first)
CREATE OR REPLACE FUNCTION app.bill_calls(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(app.bill_redact(CASE WHEN jsonb_typeof(x.e) = 'object' THEN x.e ELSE jsonb_build_object('value', x.e) END) ORDER BY x.o), '[]'::jsonb)
    INTO v FROM jsonb_array_elements(p) WITH ORDINALITY x(e, o) WHERE x.o <= 50;
  IF octet_length(v::text) > 262144 THEN
    SELECT coalesce(jsonb_agg((x.e - 'request' - 'response') || jsonb_build_object('truncated', true) ORDER BY x.o), '[]'::jsonb)
      INTO v FROM jsonb_array_elements(v) WITH ORDINALITY x(e, o);
  END IF;
  IF octet_length(v::text) > 262144 THEN v := '[]'::jsonb; END IF;
  RETURN v;
END $$;

-- error object {kind, code, message, http_status} (texts cut to their column sizes)
CREATE OR REPLACE FUNCTION app.bill_error(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_http int;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  PERFORM app.only_keys(p, ARRAY['kind','code','message','http_status']);
  IF jsonb_typeof(p -> 'http_status') NOT IN ('number','null') THEN PERFORM app.fail('MRS_INVALID', 'http_status'); END IF;
  IF jsonb_typeof(p -> 'http_status') = 'number' THEN
    IF (p ->> 'http_status') !~ '^[0-9]{3}$' THEN PERFORM app.fail('MRS_INVALID', 'http_status'); END IF;
    v_http := (p ->> 'http_status')::int;
  END IF;
  IF jsonb_typeof(p -> 'kind') IN ('object','array') OR jsonb_typeof(p -> 'code') IN ('object','array')
     OR jsonb_typeof(p -> 'message') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'error'); END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('kind', left(app.bill_scrub_text(p ->> 'kind'), 60), 'code', left(app.bill_scrub_text(p ->> 'code'), 60),
                                              'message', left(app.bill_redact(p -> 'message') #>> '{}', 500), 'http_status', v_http));
END $$;

-- remote figures {net, vat, total}
CREATE OR REPLACE FUNCTION app.bill_totals(p jsonb) RETURNS numeric[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN ARRAY[NULL, NULL, NULL]::numeric[]; END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'remote_totals'); END IF;
  RETURN ARRAY[app.fin_money(p, 'net'), app.fin_money(p, 'vat'), app.fin_money(p, 'total')];
END $$;

CREATE OR REPLACE FUNCTION app.bill_diff(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 500 THEN PERFORM app.fail('MRS_INVALID', 'diff'); END IF;
  RETURN app.bill_redact(p);
END $$;

-- a Daftra invoice id may back one intent only
CREATE OR REPLACE FUNCTION app.bill_check_invoice_free(p_org uuid, p_intent uuid, p_ext text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_other uuid;
BEGIN
  IF p_ext IS NULL THEN RETURN; END IF;
  SELECT i.id INTO v_other FROM public.billing_intents i WHERE i.org_id = p_org AND i.external_invoice_id = p_ext AND i.id <> p_intent;
  IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
END $$;

-- one client effect (ok: adopted / created / refreshed / pushed; conflict: candidates → needs_review)
CREATE OR REPLACE FUNCTION app.bill_client_effect(p_org uuid, p_eff jsonb, p_link uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.daftra_client_links; v_lid uuid; v_ext text; v_by text; v_remote jsonb; v_pushed jsonb; v_c public.clients;
        v_other uuid; v_cands jsonb; e jsonb; v_drift text[];
BEGIN
  IF p_eff IS NULL OR jsonb_typeof(p_eff) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'clients'); END IF;
  v_lid := app.puuid(p_eff, 'client_link_id');
  IF v_lid IS NULL OR (p_link IS NOT NULL AND v_lid <> p_link) THEN PERFORM app.fail('MRS_INVALID', 'client_link_id'); END IF;
  SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.id = v_lid AND l.org_id = p_org FOR UPDATE;
  IF v_l.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'client_link_id'); END IF;
  IF v_l.status = 'unlinked' THEN RETURN; END IF;
  IF p_eff ? 'candidates' THEN
    v_cands := p_eff -> 'candidates';
    IF jsonb_typeof(v_cands) <> 'array' OR jsonb_array_length(v_cands) > 10 THEN PERFORM app.fail('MRS_INVALID', 'candidates'); END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('external_id', app.bill_ext_id(app.bill_rtext(x, 'external_id', 64), 'candidates'),
                                                 'name', app.bill_rtext(x, 'name', 300), 'vat_number', app.bill_rtext(x, 'vat_number', 40))), '[]'::jsonb)
      INTO v_cands FROM jsonb_array_elements(v_cands) x;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_cands) x WHERE x ->> 'external_id' IS NULL) THEN PERFORM app.fail('MRS_INVALID', 'candidates'); END IF;
    UPDATE public.daftra_client_links l SET status = 'needs_review', candidates = v_cands, last_synced_at = now(),
           last_error_code = 'needs_review', last_error_message = NULL WHERE l.id = v_l.id;
    RETURN;
  END IF;
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_id', 64), 'external_id');
  IF v_ext IS NULL THEN PERFORM app.fail('MRS_INVALID', 'external_id'); END IF;
  v_by := app.bill_rtext(p_eff, 'found_by', 20);
  IF v_by IS NULL OR v_by NOT IN ('ref','created','manual','pushed') THEN PERFORM app.fail('MRS_INVALID', 'found_by'); END IF;
  v_remote := app.bill_snap_norm(p_eff -> 'remote_snapshot', 'remote_snapshot');
  v_pushed := app.bill_snap_norm(p_eff -> 'pushed_snapshot', 'pushed_snapshot');
  SELECT l.id INTO v_other FROM public.daftra_client_links l
   WHERE l.org_id = p_org AND l.external_id = v_ext AND l.status <> 'unlinked' AND l.id <> v_l.id;
  IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
  SELECT * INTO v_c FROM public.clients c WHERE c.id = v_l.client_id;
  -- 'manual' (client_refresh): a pending manual link / chosen candidate adopts the remote as baseline; a link that is
  -- already linked keeps its baseline, so a change made in Daftra shows as remote:<field> drift (never overwritten)
  v_pushed := CASE v_by WHEN 'manual' THEN CASE WHEN v_l.status IN ('linked','drift') AND v_l.external_id = v_ext AND v_l.pushed_snapshot IS NOT NULL
                                                 THEN v_l.pushed_snapshot ELSE coalesce(v_remote, v_pushed) END
                        WHEN 'pushed' THEN coalesce(v_pushed, app.bill_client_snapshot(v_c))
                        ELSE coalesce(v_pushed, CASE WHEN v_l.external_id = v_ext THEN v_l.pushed_snapshot END, v_remote) END;
  UPDATE public.daftra_client_links l SET external_id = v_ext, remote_snapshot = coalesce(v_remote, l.remote_snapshot),
         pushed_snapshot = v_pushed, candidates = NULL, last_synced_at = now(), last_error_code = NULL, last_error_message = NULL,
         linked_at = coalesce(l.linked_at, now()), status = 'linked'
   WHERE l.id = v_l.id RETURNING * INTO v_l;
  v_drift := app.bill_client_drift(v_l);
  UPDATE public.daftra_client_links l SET drift = v_drift, status = CASE WHEN cardinality(v_drift) > 0 THEN 'drift' ELSE 'linked' END,
         drift_detected_at = CASE WHEN cardinality(v_drift) > 0 THEN coalesce(l.drift_detected_at, now()) END
   WHERE l.id = v_l.id;
END $$;

-- one item effect (ok: adopted / created / verified; conflict: candidates → needs_review)
CREATE OR REPLACE FUNCTION app.bill_item_effect(p_org uuid, p_eff jsonb, p_item uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.daftra_item_links; v_iid uuid; v_ext text; v_other uuid; v_cands jsonb;
BEGIN
  IF p_eff IS NULL OR jsonb_typeof(p_eff) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'items'); END IF;
  v_iid := app.puuid(p_eff, 'item_link_id');
  IF v_iid IS NULL OR (p_item IS NOT NULL AND v_iid <> p_item) THEN PERFORM app.fail('MRS_INVALID', 'item_link_id'); END IF;
  SELECT * INTO v_i FROM public.daftra_item_links i WHERE i.id = v_iid AND i.org_id = p_org FOR UPDATE;
  IF v_i.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'item_link_id'); END IF;
  IF v_i.status = 'retired' THEN RETURN; END IF;
  IF p_eff ? 'candidates' THEN
    v_cands := p_eff -> 'candidates';
    IF jsonb_typeof(v_cands) <> 'array' OR jsonb_array_length(v_cands) > 10 THEN PERFORM app.fail('MRS_INVALID', 'candidates'); END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('external_product_id',
                                app.bill_ext_id(coalesce(app.bill_rtext(x, 'external_product_id', 64), app.bill_rtext(x, 'external_id', 64), app.bill_rtext(x, 'id', 64)), 'candidates'),
                              'code', app.bill_rtext(x, 'code', 80), 'name', app.bill_rtext(x, 'name', 300))), '[]'::jsonb)
      INTO v_cands FROM jsonb_array_elements(v_cands) x;
    UPDATE public.daftra_item_links i SET status = 'needs_review', candidates = v_cands, last_synced_at = now(),
           last_error_code = 'needs_review', last_error_message = NULL WHERE i.id = v_i.id;
    RETURN;
  END IF;
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_product_id', 64), 'external_product_id');
  IF v_ext IS NULL THEN PERFORM app.fail('MRS_INVALID', 'external_product_id'); END IF;
  IF app.bill_rtext(p_eff, 'found_by', 20) IS NULL THEN PERFORM app.fail('MRS_INVALID', 'found_by'); END IF;
  SELECT i.id INTO v_other FROM public.daftra_item_links i
   WHERE i.org_id = p_org AND i.external_product_id = v_ext AND i.status <> 'retired' AND i.id <> v_i.id;
  IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
  UPDATE public.daftra_item_links i SET external_product_id = v_ext, status = 'linked', candidates = NULL, last_synced_at = now(),
         last_error_code = NULL, last_error_message = NULL WHERE i.id = v_i.id;
END $$;

-- inline client / item effects carried by invoice jobs
CREATE OR REPLACE FUNCTION app.bill_inline_effects(p_org uuid, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb;
BEGIN
  IF p_eff ? 'clients' THEN
    IF jsonb_typeof(p_eff -> 'clients') <> 'array' THEN PERFORM app.fail('MRS_INVALID', 'clients'); END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_eff -> 'clients') x LOOP PERFORM app.bill_client_effect(p_org, e, NULL); END LOOP;
  END IF;
  IF p_eff ? 'items' THEN
    IF jsonb_typeof(p_eff -> 'items') <> 'array' THEN PERFORM app.fail('MRS_INVALID', 'items'); END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_eff -> 'items') x LOOP PERFORM app.bill_item_effect(p_org, e, NULL); END LOOP;
  END IF;
END $$;

-- line_results: pending_add → synced (pushed); pending_remove → removed when reported removed; synced report on pending_remove → pushed only
CREATE OR REPLACE FUNCTION app.bill_line_results(p_i public.billing_intents, p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; v_lid uuid; v_st text; v_rl text; v_l public.billing_intent_lines;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN; END IF;
  IF jsonb_typeof(p) <> 'array' THEN PERFORM app.fail('MRS_INVALID', 'line_results'); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'line_results'); END IF;
    v_lid := app.puuid(e, 'line_id');
    v_st := app.bill_rtext(e, 'state', 20);
    v_rl := app.bill_ext_id(app.bill_rtext(e, 'remote_line_id', 64), 'remote_line_id');
    IF v_lid IS NULL OR v_st IS NULL OR v_st NOT IN ('synced','removed') THEN PERFORM app.fail('MRS_INVALID', 'line_results'); END IF;
    SELECT * INTO v_l FROM public.billing_intent_lines l WHERE l.id = v_lid AND l.intent_id = p_i.id FOR UPDATE;
    IF v_l.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'line_results'); END IF;
    IF v_st = 'synced' THEN
      IF v_l.state = 'pending_add' THEN
        UPDATE public.billing_intent_lines l SET state = 'synced', pushed = true, remote_line_id = coalesce(v_rl, l.remote_line_id) WHERE l.id = v_l.id;
      ELSIF v_l.state IN ('synced','pending_remove') THEN
        UPDATE public.billing_intent_lines l SET pushed = true, remote_line_id = coalesce(v_rl, l.remote_line_id) WHERE l.id = v_l.id;
      END IF;
    ELSIF v_l.state = 'pending_remove' THEN
      UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(), removed_reason = coalesce(l.removed_reason, 'removed') WHERE l.id = v_l.id;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.bill_has_pending(p_intent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.intent_id = p_intent AND l.state IN ('pending_add','pending_remove'))
$$;

-- an invoice conflict (remote_edited | remote_missing | external_in_use); client / item review → sync error
CREATE OR REPLACE FUNCTION app.bill_apply_conflict(p_i public.billing_intents, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := app.bill_rtext(p_eff, 'reason', 40); v_rh text; v_ext text; v_snap jsonb;
BEGIN
  IF v_reason IS NULL OR v_reason NOT IN ('remote_edited','remote_missing','external_in_use','client_review','item_review') THEN
    PERFORM app.fail('MRS_INVALID', 'reason');
  END IF;
  IF v_reason IN ('client_review','item_review') THEN
    UPDATE public.billing_intents i SET sync_state = 'error', last_error_code = v_reason, last_error_message = NULL, last_synced_at = now()
     WHERE i.id = p_i.id;
    RETURN;
  END IF;
  v_rh := app.bill_hash(app.bill_rtext(p_eff, 'remote_hash', 64), 'remote_hash');
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_invoice_id', 64), 'external_invoice_id');
  v_snap := p_eff -> 'remote_snapshot';
  IF v_snap IS NOT NULL AND jsonb_typeof(v_snap) NOT IN ('object','null') THEN PERFORM app.fail('MRS_INVALID', 'remote_snapshot'); END IF;
  IF v_reason = 'remote_edited' AND p_i.external_invoice_id IS NULL AND v_ext IS NOT NULL THEN
    PERFORM app.bill_check_invoice_free(p_i.org_id, p_i.id, v_ext);
    UPDATE public.billing_intents i SET external_invoice_id = v_ext, status = CASE WHEN i.status = 'open' THEN 'draft' ELSE i.status END
     WHERE i.id = p_i.id;
  END IF;
  UPDATE public.billing_intents i SET sync_state = 'conflict', remote_hash = coalesce(v_rh, i.remote_hash), last_synced_at = now(),
         last_error_code = v_reason, last_error_message = NULL,
         conflict = app.bill_bound_details(jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'diff', app.bill_diff(p_eff -> 'diff'), 'detected_at', now(),
                                                         'remote_hash', v_rh, 'remote_snapshot', app.bill_redact(v_snap),
                                                         'external_ids', CASE WHEN v_reason = 'external_in_use' THEN app.bill_redact(p_eff -> 'external_ids') END,
                                                         'external_invoice_id', v_ext)))
   WHERE i.id = p_i.id;
  PERFORM app.bill_event(p_i.org_id, p_i.transaction_id, 'conflict', 'billing_intent', p_i.id, jsonb_build_object('reason', v_reason));
END $$;

-- invoice_pull effects (also a push outcome 'frozen')
CREATE OR REPLACE FUNCTION app.bill_apply_pull(p_i public.billing_intents, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_ext text; v_state text; v_rh text; v_tot numeric[]; v_pay jsonb; v_ps text; v_paid numeric;
        v_pat timestamptz; v_prev_pay text := p_i.payment_status; v_push_live boolean;
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
    last_pulled_at = now(), last_synced_at = now(), last_error_code = NULL, last_error_message = NULL,
    sync_state = CASE WHEN i.sync_state = 'in_flight' THEN CASE WHEN app.bill_has_pending(i.id) THEN 'pending' ELSE 'synced' END ELSE i.sync_state END
   WHERE i.id = p_i.id RETURNING * INTO v_i;
  -- while a push of this intent is pending / in flight / unknown, the pull only refreshes the mirror: the push re-reads
  -- the remote itself and decides (a lost update is not an accountant edit)
  v_push_live := v_i.sync_state IN ('unknown','in_flight')
                 OR EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.intent_id = v_i.id AND j.kind = 'invoice_push'
                              AND j.status IN ('queued','unknown'));     -- 'running' = this very push (frozen path): one lane per org
  IF v_state = 'draft' THEN
    -- manual edit detected on pull too (step ٩): never fixed, a conflict for a human
    IF v_i.status = 'draft' AND v_i.pushed_hash IS NOT NULL AND v_rh IS NOT NULL AND v_rh <> v_i.pushed_hash AND v_i.sync_state <> 'conflict'
       AND NOT v_push_live THEN
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
END $$;

-- invoice_push ok effects
CREATE OR REPLACE FUNCTION app.bill_apply_push_ok(p_i public.billing_intents, p_eff jsonb, p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_ext text; v_state text; v_by text; v_ph text; v_rh text; v_tot numeric[];
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
  UPDATE public.billing_intents i SET external_invoice_id = v_ext, status = CASE WHEN i.status = 'open' THEN 'draft' ELSE i.status END,
         daftra_number = coalesce(app.bill_rtext(p_eff, 'daftra_number', 60), i.daftra_number),
         daftra_status = coalesce(app.bill_rtext(p_eff, 'daftra_status', 40), i.daftra_status),
         remote_version = coalesce(app.bill_rtext(p_eff, 'remote_version', 64), i.remote_version),
         pushed_hash = v_ph, remote_hash = coalesce(v_rh, v_ph), pushed_at = now(), last_synced_at = now(),
         remote_net = coalesce(v_tot[1], i.remote_net), remote_vat = coalesce(v_tot[2], i.remote_vat), remote_total = coalesce(v_tot[3], i.remote_total),
         conflict = NULL, last_error_code = NULL, last_error_message = NULL
   WHERE i.id = p_i.id RETURNING * INTO v_i;
  PERFORM app.bill_line_results(v_i, p_eff -> 'line_results');
  UPDATE public.billing_intents i SET sync_state = CASE WHEN app.bill_has_pending(i.id) THEN 'pending' ELSE 'synced' END
   WHERE i.id = p_i.id;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'draft_synced', 'billing_intent', v_i.id,
    jsonb_build_object('job_id', p_job, 'found_by', v_by));
  PERFORM app.bill_tx_financial(v_i.transaction_id);
END $$;

-- invoice job completion on the intent (lock order: transaction → intent → lines → charges)
CREATE OR REPLACE FUNCTION app.bill_apply_intent(j public.billing_sync_jobs, p_outcome text, p_eff jsonb, p_err jsonb, p_final boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_tx uuid; v_ext text; v_reason text;
BEGIN
  SELECT i.transaction_id INTO v_tx FROM public.billing_intents i WHERE i.id = j.intent_id;
  PERFORM 1 FROM public.transactions t WHERE t.id = v_tx FOR UPDATE;
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = j.intent_id FOR UPDATE;
  IF p_eff ? 'intent_id' AND app.puuid(p_eff, 'intent_id') IS DISTINCT FROM j.intent_id THEN PERFORM app.fail('MRS_INVALID', 'intent_id'); END IF;
  PERFORM app.bill_inline_effects(j.org_id, p_eff);
  IF v_i.status = 'cancelled' THEN RETURN; END IF;
  IF j.kind = 'invoice_pull' THEN
    IF p_outcome = 'ok' THEN
      PERFORM app.bill_apply_pull(v_i, p_eff);
    ELSIF p_outcome = 'conflict' THEN
      v_reason := coalesce(app.bill_rtext(p_eff, 'reason', 40), 'remote_missing');
      IF v_i.status = 'issued' THEN
        INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
        VALUES (v_i.org_id, v_i.transaction_id, v_i.id, 'issued_cancelled', jsonb_build_object('reason', v_reason))
        ON CONFLICT (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL DO NOTHING;
        UPDATE public.billing_intents i SET last_pulled_at = now(), last_error_code = v_reason WHERE i.id = v_i.id;
      ELSE
        PERFORM app.bill_apply_conflict(v_i, p_eff || jsonb_build_object('reason', v_reason));
      END IF;
    ELSE
      UPDATE public.billing_intents i SET last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60),
             last_error_message = p_err ->> 'message' WHERE i.id = v_i.id;
    END IF;
    RETURN;
  END IF;
  -- invoice_push
  IF v_i.status = 'issued' THEN
    -- issued meanwhile: never edited; a pull-shaped result may still refresh the mirror
    IF p_outcome = 'frozen' THEN PERFORM app.bill_apply_pull(v_i, p_eff); END IF;
    RETURN;
  END IF;
  IF p_outcome = 'ok' THEN
    PERFORM app.bill_apply_push_ok(v_i, p_eff, j.id);
  ELSIF p_outcome = 'frozen' THEN
    IF coalesce(app.bill_rtext(p_eff, 'remote_state', 20), '') NOT IN ('issued','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'remote_state'); END IF;
    PERFORM app.bill_apply_pull(v_i, p_eff);
  ELSIF p_outcome = 'conflict' THEN
    PERFORM app.bill_apply_conflict(v_i, p_eff);
  ELSIF p_outcome = 'unknown' THEN
    v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_invoice_id', 64), 'external_invoice_id');
    IF v_ext IS NOT NULL AND v_i.external_invoice_id IS NULL THEN
      PERFORM app.bill_check_invoice_free(v_i.org_id, v_i.id, v_ext);
      UPDATE public.billing_intents i SET external_invoice_id = v_ext, status = CASE WHEN i.status = 'open' THEN 'draft' ELSE i.status END
       WHERE i.id = v_i.id;
    END IF;
    UPDATE public.billing_intents i SET sync_state = 'unknown', last_synced_at = now(),
           last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', 'unknown'), 60), last_error_message = p_err ->> 'message'
     WHERE i.id = v_i.id;
  ELSE
    -- retry / failed / dead: a write that may have reached Daftra earlier stays «unknown» until a reconcile succeeds
    UPDATE public.billing_intents i SET sync_state = CASE WHEN app.bill_job_unreconciled(j.id) THEN 'unknown' ELSE 'error' END,
           last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60), last_error_message = p_err ->> 'message'
     WHERE i.id = v_i.id;
    IF p_final THEN
      PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'sync_failed', 'billing_intent', v_i.id, jsonb_build_object('job_id', j.id));
    END IF;
  END IF;
END $$;

-- probe completion: capabilities + connection status (connected on success, error on a final failure)
CREATE OR REPLACE FUNCTION app.bill_apply_probe(j public.billing_sync_jobs, a public.billing_sync_attempts, p_outcome text, p_eff jsonb,
  p_err jsonb, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_caps jsonb := '{}'::jsonb; k text; v jsonb; v_c public.daftra_connections;
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
    IF (v_c.mode = 'mock') IS DISTINCT FROM (a.adapter_mode = 'mock') THEN RETURN; END IF;   -- mode changed meanwhile: stale result
    UPDATE public.daftra_connections c SET capabilities = v_caps, capabilities_checked_at = now(), capabilities_source = a.adapter_mode,
           last_check_at = now(), last_check_status = 'ok', last_error_code = NULL, last_error_message = NULL, status = 'connected'
     WHERE c.id = v_c.id;
  ELSE
    UPDATE public.daftra_connections c SET last_check_at = now(), last_check_status = 'failed',
           last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60), last_error_message = p_err ->> 'message',
           status = CASE WHEN p_final OR p_outcome = 'conflict' THEN 'error' ELSE c.status END
     WHERE c.id = v_c.id;
  END IF;
END $$;

-- client job completion
CREATE OR REPLACE FUNCTION app.bill_apply_client(j public.billing_sync_jobs, p_outcome text, p_eff jsonb, p_err jsonb, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_outcome = 'ok' OR (p_outcome = 'conflict' AND p_eff ? 'candidates') THEN
    PERFORM app.bill_client_effect(j.org_id, p_eff, j.client_link_id);
  ELSE
    UPDATE public.daftra_client_links l SET last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60),
           last_error_message = p_err ->> 'message',
           status = CASE WHEN (p_final OR p_outcome = 'conflict') AND l.status = 'pending' THEN 'error' ELSE l.status END
     WHERE l.id = j.client_link_id AND l.status <> 'unlinked';
  END IF;
END $$;

-- item job completion
CREATE OR REPLACE FUNCTION app.bill_apply_item(j public.billing_sync_jobs, p_outcome text, p_eff jsonb, p_err jsonb, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_outcome = 'ok' OR (p_outcome = 'conflict' AND p_eff ? 'candidates') THEN
    PERFORM app.bill_item_effect(j.org_id, p_eff, j.item_link_id);
  ELSE
    UPDATE public.daftra_item_links i SET last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60),
           last_error_message = p_err ->> 'message',
           status = CASE WHEN (p_final OR p_outcome = 'conflict') AND i.status = 'pending' THEN 'error' ELSE i.status END
     WHERE i.id = j.item_link_id AND i.status <> 'retired';
  END IF;
END $$;

-- validated completion (raises on invalid input; the caller turns that into a failed attempt)
CREATE OR REPLACE FUNCTION app.bill_complete(j public.billing_sync_jobs, a public.billing_sync_attempts, p_result jsonb, p_calls jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_outcome text; v_eff jsonb; v_err jsonb; v_exp text; v_status text; v_final boolean;
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
  v_status := CASE v_outcome
                WHEN 'ok' THEN 'done' WHEN 'frozen' THEN 'done' WHEN 'failed' THEN 'failed' WHEN 'conflict' THEN 'conflict'
                WHEN 'retry' THEN CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END
                ELSE CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'unknown' END END;
  v_final := v_status IN ('failed','dead');
  CASE j.kind
    WHEN 'probe' THEN PERFORM app.bill_apply_probe(j, a, v_outcome, v_eff, v_err, v_final);
    WHEN 'item_ensure' THEN PERFORM app.bill_apply_item(j, v_outcome, v_eff, v_err, v_final);
    WHEN 'invoice_push', 'invoice_pull' THEN PERFORM app.bill_apply_intent(j, v_outcome, v_eff, v_err, v_final);
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

-- daftra_renew_lease(p_attempt) → {job_id, locked_until}: called by the worker right before every adapter WRITE.
--   The attempt must still be open and its job running, held by this attempt's worker and attempt number; the lease is
--   extended by 5 minutes. Otherwise MRS_BAD_TRANSITION 'lease_lost' and the worker sends nothing (write fencing).
CREATE OR REPLACE FUNCTION public.daftra_renew_lease(p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.billing_sync_attempts; v_j public.billing_sync_jobs;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO v_a FROM public.billing_sync_attempts a WHERE a.id = p_attempt;
  IF v_a.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'attempt'); END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = v_a.job_id FOR UPDATE;
  SELECT * INTO v_a FROM public.billing_sync_attempts a WHERE a.id = p_attempt;
  IF v_a.outcome IS NOT NULL OR v_j.status <> 'running' OR v_j.locked_by IS DISTINCT FROM v_a.worker
     OR v_j.attempts <> v_a.attempt_no OR v_j.locked_until IS NULL OR v_j.locked_until < now() THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'lease_lost');
  END IF;
  UPDATE public.billing_sync_jobs j SET locked_until = now() + interval '5 minutes' WHERE j.id = v_j.id RETURNING * INTO v_j;
  RETURN jsonb_build_object('job_id', v_j.id, 'locked_until', v_j.locked_until);
END $$;

-- daftra_complete_job(p_attempt, p_result) → {job_id, job_status, applied}
--   lock order = the staff RPCs' order: transaction → intent → attempt → job (no inversion, no deadlock)
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
  END IF;
  SELECT * INTO v_a FROM public.billing_sync_attempts a WHERE a.id = p_attempt FOR UPDATE;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = v_a.job_id FOR UPDATE;
  v_calls := app.bill_calls(CASE WHEN jsonb_typeof(p_result) = 'object' THEN p_result -> 'calls' END);
  IF v_a.outcome IS NOT NULL THEN
    -- already closed (abandoned after a lease expiry): history is never rewritten. A write the late worker reports as
    -- applied (or possibly applied) marks the intent «unknown», so the next push starts with the reference lookup
    -- (a duplicate becomes an external_in_use conflict, never silent); a billing event names the ops (no bodies).
    SELECT coalesce(array_agg(DISTINCT c ->> 'op' ORDER BY c ->> 'op'), '{}') INTO v_late FROM jsonb_array_elements(v_calls) c
     WHERE c ->> 'op' IN ('createClient','updateClient','createProduct','createDraftInvoice','updateDraftInvoice')
       AND coalesce(c ->> 'applied', 'no') IN ('yes','unknown');
    IF cardinality(v_late) > 0 AND v_j.intent_id IS NOT NULL THEN
      UPDATE public.billing_intents i SET sync_state = 'unknown', last_error_code = 'late_write',
             last_error_message = 'a worker wrote to Daftra after losing its lease: reconcile by reference'
       WHERE i.id = v_j.intent_id AND i.status IN ('open','draft');
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
    END IF;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', 'failed', 'applied', false, 'outcome', 'failed', 'error', v_err);
  END;
  RETURN v_res;
END $$;

-- daftra_schedule_pulls(p_limit) → {enqueued}: drafts / unpaid issued invoices not pulled for 15 min
CREATE OR REPLACE FUNCTION public.daftra_schedule_pulls(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_n int := 0; v_job jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  FOR r IN SELECT i.id, i.org_id FROM public.billing_intents i JOIN public.daftra_connections c ON c.org_id = i.org_id AND c.sync_enabled
            WHERE i.external_invoice_id IS NOT NULL AND i.status IN ('draft','issued') AND i.payment_status <> 'paid'
              AND (i.last_pulled_at IS NULL OR i.last_pulled_at < now() - interval '15 minutes')
              AND NOT EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.org_id = i.org_id AND j.dedupe_key = 'invoice_pull:' || i.id::text
                                AND j.status IN ('queued','running','unknown'))
            ORDER BY i.last_pulled_at NULLS FIRST, i.id LIMIT p_limit LOOP
    v_job := app.bill_enqueue(r.org_id, 'invoice_pull', r.id, NULL, NULL, '{}'::jsonb, NULL);
    IF NOT (v_job -> 'deduplicated')::boolean THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('enqueued', v_n);
END $$;

-- §14 mock account state (staging demo; index.ts in mock mode only)
CREATE OR REPLACE FUNCTION public.daftra_mock_load(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_mock_accounts;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN PERFORM app.fail('MRS_NOT_FOUND', 'org'); END IF;
  SELECT * INTO v FROM public.daftra_mock_accounts m WHERE m.org_id = p_org;
  RETURN jsonb_build_object('state', coalesce(v.state, '{}'::jsonb), 'version', coalesce(v.version, 0));
END $$;

CREATE OR REPLACE FUNCTION public.daftra_mock_save(p_org uuid, p_state jsonb, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_mock_accounts;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN PERFORM app.fail('MRS_NOT_FOUND', 'org'); END IF;
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'state'); END IF;
  IF p_version IS NULL OR p_version < 0 THEN PERFORM app.fail('MRS_INVALID', 'version'); END IF;
  SELECT * INTO v FROM public.daftra_mock_accounts m WHERE m.org_id = p_org FOR UPDATE;
  IF coalesce(v.version, 0) <> p_version THEN PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'mock_version', coalesce(v.version, 0)::text); END IF;
  IF v.org_id IS NULL THEN
    INSERT INTO public.daftra_mock_accounts (org_id, state, version) VALUES (p_org, p_state, 1) RETURNING * INTO v;
  ELSE
    UPDATE public.daftra_mock_accounts m SET state = p_state, version = m.version + 1, updated_at = now() WHERE m.org_id = p_org RETURNING * INTO v;
  END IF;
  RETURN jsonb_build_object('version', v.version);
END $$;

-- ---------------------------------------------------------------------
-- audit + updated_at
--   trg_audit on every G5 table except billing_sync_attempts (itself the append-only history; its calls payloads
--   never reach audit_log) and daftra_mock_accounts (fake account state).
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['daftra_connections','daftra_client_links','daftra_item_links','billing_intents','billing_intent_lines',
                           'billing_sync_jobs','billing_review_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
  DROP TRIGGER IF EXISTS trg_touch ON public.daftra_mock_accounts;
  CREATE TRIGGER trg_touch BEFORE UPDATE ON public.daftra_mock_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
END $$;

-- ---------------------------------------------------------------------
-- RLS, policies, grants — finance read roles only; clients: no policy at all; no direct writes
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['daftra_connections','daftra_client_links','daftra_item_links','billing_intents','billing_intent_lines',
                           'billing_sync_jobs','billing_sync_attempts','billing_review_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
  ALTER TABLE public.daftra_mock_accounts ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.daftra_mock_accounts FROM PUBLIC, anon, authenticated;
END $$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['daftra_connections','daftra_client_links','daftra_item_links','billing_intents',
  'billing_intent_lines','billing_sync_jobs','billing_sync_attempts','billing_review_items','daftra_mock_accounts']) t;

CREATE POLICY daftra_connections_select ON public.daftra_connections FOR SELECT TO authenticated
  USING (app.has_role(org_id, app.fin_read_roles()));
CREATE POLICY daftra_client_links_select ON public.daftra_client_links FOR SELECT TO authenticated
  USING (app.has_role(org_id, app.fin_read_roles()));
CREATE POLICY daftra_item_links_select ON public.daftra_item_links FOR SELECT TO authenticated
  USING (app.has_role(org_id, app.fin_read_roles()));
CREATE POLICY billing_intents_select ON public.billing_intents FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY billing_intent_lines_select ON public.billing_intent_lines FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY billing_review_items_select ON public.billing_review_items FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY billing_sync_jobs_select ON public.billing_sync_jobs FOR SELECT TO authenticated
  USING (app.bill_can_read_job(billing_sync_jobs));
CREATE POLICY billing_sync_attempts_select ON public.billing_sync_attempts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.id = job_id AND app.bill_can_read_job(j)));
-- daftra_mock_accounts: no policy (service role only)

-- G5-6 «clients see nothing from G5»: transactions.financial_status now carries the real billing state (G5-7), so it
-- joins the 0700 hidden columns (fail closed: every other column re-granted). Staff read it through
-- staff_internal_fields('transactions') (MarsaApi withInternal) and tx_billing / get_billing_intent.
DO $fin_col$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'transactions'
     AND NOT (c.column_name = ANY (ARRAY['notes','tracking_token_hash','financial_status']));
  EXECUTE 'REVOKE SELECT ON public.transactions FROM authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.transactions TO authenticated', v_cols);
END $fin_col$;

-- staff_internal_fields: + transactions.financial_status (body otherwise identical to G3 20261103000100 §9)
CREATE OR REPLACE FUNCTION public.staff_internal_fields(p_table text, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_ids) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  IF p_table = 'transactions' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(t.id::text, jsonb_build_object('notes', t.notes, 'financial_status', t.financial_status))
        FROM public.transactions t
       WHERE t.id = ANY (p_ids) AND app.has_branch_role(t.org_id, t.branch_id, app.staff_roles())), '{}'::jsonb);
  ELSIF p_table = 'clients' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(c.id::text, jsonb_build_object('notes', c.notes, 'classification', c.classification))
        FROM public.clients c
       WHERE c.id = ANY (p_ids) AND app.is_staff(c.org_id)), '{}'::jsonb);
  ELSIF p_table = 'customs_declarations' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(d.id::text, jsonb_build_object('notes', d.notes, 'cancel_reason', d.cancel_reason))
        FROM public.customs_declarations d
       WHERE d.id = ANY (p_ids) AND app.has_tx_role(d.transaction_id, app.staff_roles())), '{}'::jsonb);
  ELSIF p_table = 'bills_of_lading' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(b.id::text, jsonb_build_object('notes', b.notes))
        FROM public.bills_of_lading b
       WHERE b.id = ANY (p_ids) AND app.can_read_bl(b.id, b.org_id)), '{}'::jsonb);
  END IF;
  PERFORM app.fail('MRS_INVALID', 'table');
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.staff_internal_fields(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_internal_fields(text, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------
-- every G5 app.* helper / trigger function: revoked from everyone (SECURITY DEFINER callers run them)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND (p.proname LIKE 'bill\_%' OR p.proname LIKE 'tg\_bill\_%') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;
-- policy helper (RLS runs it as the caller)
GRANT EXECUTE ON FUNCTION app.bill_can_read_job(public.billing_sync_jobs) TO authenticated;

-- staff RPCs: authenticated
REVOKE EXECUTE ON FUNCTION
  public.get_daftra_connection(uuid), public.save_daftra_connection(uuid, jsonb), public.request_daftra_probe(uuid, uuid),
  public.list_daftra_client_links(uuid, jsonb), public.link_daftra_client(uuid, text, uuid), public.refresh_daftra_client(uuid),
  public.resolve_client_drift(uuid, text, text, text), public.unlink_daftra_client(uuid, text), public.list_daftra_items(uuid),
  public.save_daftra_item(uuid, text, jsonb), public.create_billing_intent(jsonb, uuid), public.add_billing_lines(uuid, uuid[], uuid),
  public.remove_billing_line(uuid, text), public.request_billing_push(uuid, uuid), public.request_billing_pull(uuid),
  public.resolve_billing_conflict(uuid, text, text), public.cancel_billing_intent(uuid, text), public.retry_billing_job(uuid),
  public.list_billing_intents(uuid, jsonb), public.get_billing_intent(uuid), public.list_billing_jobs(uuid, jsonb),
  public.get_billing_job(uuid), public.billing_review_queue(uuid, jsonb), public.resolve_billing_review(uuid, text, text, uuid),
  public.tx_billing(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.get_daftra_connection(uuid), public.save_daftra_connection(uuid, jsonb), public.request_daftra_probe(uuid, uuid),
  public.list_daftra_client_links(uuid, jsonb), public.link_daftra_client(uuid, text, uuid), public.refresh_daftra_client(uuid),
  public.resolve_client_drift(uuid, text, text, text), public.unlink_daftra_client(uuid, text), public.list_daftra_items(uuid),
  public.save_daftra_item(uuid, text, jsonb), public.create_billing_intent(jsonb, uuid), public.add_billing_lines(uuid, uuid[], uuid),
  public.remove_billing_line(uuid, text), public.request_billing_push(uuid, uuid), public.request_billing_pull(uuid),
  public.resolve_billing_conflict(uuid, text, text), public.cancel_billing_intent(uuid, text), public.retry_billing_job(uuid),
  public.list_billing_intents(uuid, jsonb), public.get_billing_intent(uuid), public.list_billing_jobs(uuid, jsonb),
  public.get_billing_job(uuid), public.billing_review_queue(uuid, jsonb), public.resolve_billing_review(uuid, text, text, uuid),
  public.tx_billing(uuid)
TO authenticated;

-- worker RPCs: service_role only
REVOKE EXECUTE ON FUNCTION
  public.daftra_claim_jobs(text, int), public.daftra_complete_job(uuid, jsonb), public.daftra_schedule_pulls(int),
  public.daftra_mock_load(uuid), public.daftra_mock_save(uuid, jsonb, int), public.daftra_renew_lease(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.daftra_claim_jobs(text, int), public.daftra_complete_job(uuid, jsonb), public.daftra_schedule_pulls(int),
  public.daftra_mock_load(uuid), public.daftra_mock_save(uuid, jsonb, int), public.daftra_renew_lease(uuid)
TO service_role;
