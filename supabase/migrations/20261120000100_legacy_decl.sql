-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261120000100 — legacy port, step 4: customs declaration reading, approval, HS reference
-- and the Fasah entry sheet audit (البيان الجمركي ومرجع البنود وكشف إدخال فسح) — docs/online/LEGACY_DECL_AR.md, plan
-- docs/online/LEGACY_PORT_PLAN_AR.md. Builds on legacy_docs (20261119000100). Database side of step 4 (prompt ai-doc-v3
-- declaration reading of the ai-extract Edge Function).
-- Already in step 1 (20261117000100, NOT repeated here): the Fasah stages in the status CHECK + status_labels, the
-- declaration_type domain + customs_declarations.declaration_type_code, app.norm_declaration_status / app.norm_declaration_type
-- ('تم الفسح' → released), customs_declarations.declaration_date_hijri (yyyy/mm/dd, year 1300–1700, month 1–12, day 1–30) and
-- app.norm_hijri_date (Arabic / Persian digits, d/m/yyyy). The Umm al-Qura conversion is client / Edge side (MarsaNorm,
-- extract.js): Postgres has no Umm al-Qura calendar, so the Gregorian date always arrives already recomputed.
--   P. preflight (legacy_docs applied, approve_doc_batch present) + schema_versions row
--   0. dictionaries status_labels: report_kind + fasah_sheet; decl_conflict (bl_mismatch, declaration_other_number,
--                   declaration_no_taken, status_backward, containers_roro, hijri_unverified, shipment_on_other_tx);
--                   container_source
--   1. readings     app.extraction_field_keys + the 8 declaration keys of ai-doc-v3 (declaration_type, declaration_status,
--                   declaration_date, declaration_date_hijri, importer_name_ar, broker_name, local_value, payment_method);
--                   app.extraction_detail_ok + ai_detail.declaration {type_evidence, type_read, status_raw, bl_raw,
--                   bl_candidates, bl_rtl_affected, date_printed, date_from_hijri, hijri_supported}
--   2. containers   + source (manual / doc_batch / declaration / import; API callers get 'manual', never change it)
--   3. tables       public.declaration_approvals (one per approved reading: the audited approval + the step-7 Daftra hook,
--                   daftra_hook 'deferred'), public.declaration_items (the declared items of a declaration, void-only: a new
--                   approval of the declaration voids the previous lines), public.hs_reference (org-scoped HS reference
--                   library learned ONLY from approved declarations; unique org + hs + norm(description_ar) +
--                   norm(invoice_description)). Read under RLS (staff of the transaction's branch / of the org for the
--                   library); no write grant; no DELETE; audited without the document content.
--   4. helpers      app.bl_tokens / app.bl_equivalent (legacy billReferenceEquivalent_: the same alphanumeric tokens in any
--                   order; = MarsaDocMatch.blEquivalent), app.hs_code_norm (legacy normalizeHsCode_: digits only),
--                   app.decl_try_date, app.decl_draft_of (a reading → the declaration draft), app.decl_compare (draft ↔
--                   transaction: B/L, containers, declaration, status, missing fields, conflicts), app.decl_review_version
--                   (the optimistic version of a review), app.hs_reference_learn, app.decl_merge_notes (legacy mergeNotes_)
--   5. RPCs         get_declaration_review(p_extraction, p_tx), approve_declaration_extraction(p_extraction, p_tx, p_payload),
--                   get_transaction_declaration(p_tx), search_hs_reference(p_org, p_q, p_limit); log_report_export gains
--                   the report fasah_sheet (app.rpt_export_keys re-created, report_exports CHECK widened)
--   6. conversion   app.convert_delete_tables / app.convert_delete_guards re-created with the 3 new tables
--   7. privileges
-- Every AI value stays a DRAFT until a staff member approves it; approval is audited; nothing is approved automatically.
-- The B/L of the transaction is never replaced by the declaration's reading; a B/L that is not token-equivalent is a
-- blocking conflict unless the staff member confirms it explicitly. The Daftra draft on approval is DEFERRED to step 7
-- (declaration_approvals.daftra_hook = 'deferred' + the declaration event op 'approved' are the hook).
-- Errors: + MRS_DECL_STALE, MRS_DECL_BL_MISMATCH, MRS_DECL_NUMBER_CONFLICT, MRS_DECL_ALREADY_APPROVED; otherwise existing codes.
-- Re-runnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS + CREATE /
-- ON CONFLICT). Re-pasting 20261101000100 / 20261114000100 / 20261116000100 / 20261119000100 after this file narrows the
-- field keys / ai_detail shape (declaration readings can then not be saved); re-pasting 20261115000100 … 20261119000100
-- drops the new tables from the conversion lists (the conversion then refuses: unclassified_tables); re-pasting
-- 20261106000100 drops fasah_sheet from the export audit: re-paste this file right after.
-- Down-path (staging only): DROP the RPCs of §5 and the app.* helpers of §4; DROP TABLE public.hs_reference,
-- public.declaration_items, public.declaration_approvals; ALTER TABLE public.containers DROP COLUMN source; re-paste
-- 20261119000100 §1 / §6 and 20261106000100 (rpt_export_keys, report_exports CHECK).
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261119000100') THEN
    RAISE EXCEPTION 'LEGACY DECL preflight: apply legacy_docs first (schema_versions lacks 20261119000100 legacy_docs)';
  END IF;
  IF to_regprocedure('public.approve_doc_batch(uuid,jsonb)') IS NULL OR to_regclass('public.shipment_invoice_items') IS NULL THEN
    RAISE EXCEPTION 'LEGACY DECL preflight: public.approve_doc_batch / public.shipment_invoice_items missing (apply 20261119000100 legacy_docs)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261120000100', 'legacy_decl')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('report_kind','fasah_sheet',7,'كشف إدخال فسح','Fasah entry sheet',false),
  ('decl_conflict','bl_mismatch',1,'رقم البوليصة في البيان لا يطابق بوليصة المعاملة','The B/L on the declaration differs from the transaction',false),
  ('decl_conflict','declaration_other_number',2,'للمعاملة بيان نشط برقم آخر','The transaction has an active declaration with another number',false),
  ('decl_conflict','declaration_no_taken',3,'رقم البيان مسجل لمعاملة أخرى','The declaration number belongs to another transaction',false),
  ('decl_conflict','status_backward',4,'الحالة المقروءة أقدم من حالة البيان المسجلة','The status read is behind the recorded one',false),
  ('decl_conflict','containers_roro',5,'معاملة Ro-Ro لا تقبل حاويات','A Ro-Ro transaction takes no containers',false),
  ('decl_conflict','hijri_unverified',6,'تعذر التحقق الآلي من التاريخ الهجري','The Hijri date could not be verified automatically',false),
  ('decl_conflict','shipment_on_other_tx',7,'حاويات البيان مسجلة على معاملة أخرى قائمة بنفس بوليصة البيان','The declaration''s containers are on another live transaction under the declaration''s B/L',false),
  ('container_source','manual',1,'إدخال يدوي','Manual',false),
  ('container_source','doc_batch',2,'حزمة المستندات','Document batch',false),
  ('container_source','declaration',3,'البيان الجمركي','Customs declaration',false),
  ('container_source','import',4,'استيراد','Import',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. readings: the declaration keys of ai-doc-v3, ai_detail.declaration
-- ---------------------------------------------------------------------
-- extraction_field_keys (20261119000100 §1). DECL: + the 8 declaration keys of ai-doc-v3 (= extract.js ALL_KEYS_V3). A superset.
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban',
               'vessel','voyage','port_of_loading','port_of_discharge','shipper','consignee',
               'gross_weight','net_weight','packages_count','package_type','goods_description','incoterms',
               'seal_numbers','consignee_name','notify_party','booking_number','place_of_receipt',
               'place_of_delivery','freight_terms','measurement_cbm','temperature_c','shipping_line',
               'export_country','payment_terms','packing_list_number','packing_list_date',
               'declaration_type','declaration_status','declaration_date','declaration_date_hijri',               -- DECL
               'importer_name_ar','broker_name','local_value','payment_method']                                   -- DECL
$$;

-- the declaration part of an ai-doc-v3 reading: NULL, or an object of the known keys (texts ≤ 300, ≤ 10 B/L candidates of ≤ 80)
CREATE OR REPLACE FUNCTION app.extraction_decl_detail_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e
                     WHERE NOT (e.key = ANY (ARRAY['type_evidence','type_read','status_raw','bl_raw','bl_candidates','bl_rtl_affected',
                                                   'date_printed','date_from_hijri','hijri_supported']))
                        OR (e.key IN ('bl_rtl_affected','hijri_supported') AND jsonb_typeof(e.value) NOT IN ('boolean','null'))
                        OR (e.key = 'bl_candidates' AND NOT (jsonb_typeof(e.value) = 'array' AND jsonb_array_length(e.value) <= 10
                              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.value) c
                                               WHERE jsonb_typeof(c) <> 'string' OR char_length(c #>> '{}') > 80)))
                        OR (e.key NOT IN ('bl_rtl_affected','hijri_supported','bl_candidates')
                            AND (jsonb_typeof(e.value) NOT IN ('string','null') OR char_length(e.value #>> '{}') > 300))))
$$;

-- extraction_detail_ok (20261119000100 §1). DECL: + the key declaration (app.extraction_decl_detail_ok); body otherwise identical.
CREATE OR REPLACE FUNCTION app.extraction_detail_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object' AND octet_length(p::text) <= 200000
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
                     WHERE NOT (k = ANY (ARRAY['prompt_version','detected_type','detected_documents','doc_type','containers','fields','warnings',
                                               'declaration'])))                                                              -- DECL
    AND coalesce(p ->> 'prompt_version', '') ~ '^ai-doc-v[0-9]{1,2}$'
    AND (NOT p ? 'detected_type' OR (p ->> 'detected_type') = ANY (ARRAY['bill_of_lading','commercial_invoice','packing_list',
           'customs_declaration','supplier_invoice','other']))
    AND (NOT p ? 'detected_documents' OR (jsonb_typeof(p -> 'detected_documents') = 'array' AND jsonb_array_length(p -> 'detected_documents') <= 6
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'detected_documents') t
                          WHERE jsonb_typeof(t) <> 'string' OR NOT ((t #>> '{}') = ANY (ARRAY['bill_of_lading','commercial_invoice','packing_list',
                                'customs_declaration','supplier_invoice','other'])))))
    AND (NOT p ? 'doc_type' OR char_length(p ->> 'doc_type') <= 40)
    AND (NOT p ? 'containers' OR (jsonb_typeof(p -> 'containers') = 'array' AND jsonb_array_length(p -> 'containers') <= 300
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'containers') c
                          WHERE jsonb_typeof(c) <> 'object'
                             OR jsonb_typeof(c -> 'container_number') IS DISTINCT FROM 'string'
                             OR EXISTS (SELECT 1 FROM jsonb_each(c) e
                                         WHERE NOT (e.key = ANY (ARRAY['container_number','seal_number','size_type','packages_count',
                                                                       'net_weight','gross_weight']))
                                            OR jsonb_typeof(e.value) NOT IN ('string','number','null')
                                            OR char_length(e.value #>> '{}') > 40))))
    AND (NOT p ? 'fields' OR (jsonb_typeof(p -> 'fields') = 'array' AND jsonb_array_length(p -> 'fields') <= 100))
    AND (NOT p ? 'warnings' OR (jsonb_typeof(p -> 'warnings') = 'array' AND jsonb_array_length(p -> 'warnings') <= 60))
    AND (NOT p ? 'declaration' OR app.extraction_decl_detail_ok(p -> 'declaration')))                                 -- DECL
$$;

-- ---------------------------------------------------------------------
-- 2. containers.source (who put the container on the transaction)
-- ---------------------------------------------------------------------
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_source_chk;
ALTER TABLE public.containers ADD CONSTRAINT containers_source_chk
  CHECK (source IS NULL OR source IN ('manual','doc_batch','declaration','import'));
COMMENT ON COLUMN public.containers.source IS 'legacy step 4 (20261120000100): where the container came from — manual (API / form), declaration (approve_declaration_extraction), doc_batch / import (reserved). NULL = recorded before this column. API callers cannot choose or change it.';

-- API callers: an insert is 'manual', an update keeps the stored source (the SECURITY DEFINER approvals set it)
CREATE OR REPLACE FUNCTION app.tg_containers_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF TG_OP = 'INSERT' THEN NEW.source := 'manual'; ELSE NEW.source := OLD.source; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_decl_source ON public.containers;
CREATE TRIGGER trg_legacy_decl_source BEFORE INSERT OR UPDATE ON public.containers
  FOR EACH ROW EXECUTE FUNCTION app.tg_containers_source();

-- ---------------------------------------------------------------------
-- 3. tables
-- ---------------------------------------------------------------------
-- one row per approved declaration reading: who approved what into which transaction (+ the step-7 Daftra hook)
CREATE TABLE IF NOT EXISTS public.declaration_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  transaction_id  uuid NOT NULL,
  extraction_id   uuid NOT NULL,
  declaration_id  uuid NOT NULL,
  batch_id        uuid,
  bl_status       text NOT NULL CHECK (bl_status IN ('match','mismatch_confirmed','no_transaction_bl','not_read')),
  result          jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 200000),
  daftra_hook     text NOT NULL DEFAULT 'deferred' CHECK (daftra_hook IN ('deferred','pending','done','skipped','failed')),
  approved_by     uuid NOT NULL,
  approved_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT declaration_approvals_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT declaration_approvals_ext_fk FOREIGN KEY (extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  CONSTRAINT declaration_approvals_decl_fk FOREIGN KEY (declaration_id, org_id) REFERENCES public.customs_declarations(id, org_id),
  CONSTRAINT declaration_approvals_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.doc_batches(id, org_id),
  CONSTRAINT declaration_approvals_ext_uniq UNIQUE (extraction_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.declaration_approvals IS 'legacy step 4: one row per customs declaration reading approved by a staff member (approve_declaration_extraction): the transaction, the declaration it added / corrected, the B/L check and the result. daftra_hook = deferred: the optional Daftra draft on approval is built in step 7 (never an edit of an existing Daftra draft). Written only by the RPC; no DELETE.';
CREATE INDEX IF NOT EXISTS declaration_approvals_tx_idx ON public.declaration_approvals (transaction_id, approved_at DESC);

CREATE TABLE IF NOT EXISTS public.declaration_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  transaction_id      uuid NOT NULL,
  declaration_id      uuid NOT NULL,
  approval_id         uuid NOT NULL,
  extraction_id       uuid NOT NULL,
  line_no             int NOT NULL CHECK (line_no BETWEEN 1 AND 5000),
  hs_code             text CHECK (hs_code ~ '^[0-9]{2,14}$'),
  description_ar      text CHECK (char_length(description_ar) <= 2000),
  invoice_description text CHECK (char_length(invoice_description) <= 2000),
  scientific_name     text CHECK (char_length(scientific_name) <= 300),
  quantity            numeric(18,3) CHECK (quantity >= 0),
  unit                text CHECK (char_length(unit) <= 40),
  value               numeric(18,3) CHECK (value >= 0),
  origin_country      text CHECK (char_length(origin_country) <= 120),
  net_weight_kg       numeric(16,3) CHECK (net_weight_kg >= 0),
  gross_weight_kg     numeric(16,3) CHECK (gross_weight_kg >= 0),
  invoice_number      text CHECK (char_length(invoice_number) <= 120),
  notes               text CHECK (char_length(notes) <= 500),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  voided_at           timestamptz,
  voided_by           uuid,
  void_reason         text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT declaration_items_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT declaration_items_decl_fk FOREIGN KEY (declaration_id, org_id) REFERENCES public.customs_declarations(id, org_id),
  CONSTRAINT declaration_items_approval_fk FOREIGN KEY (approval_id, org_id) REFERENCES public.declaration_approvals(id, org_id),
  CONSTRAINT declaration_items_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT declaration_items_line_chk CHECK (hs_code IS NOT NULL OR description_ar IS NOT NULL),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.declaration_items IS 'legacy step 4: the approved items of a customs declaration (HS code printed on the declaration, Arabic description, quantity, unit, value, origin, weights; invoice description / scientific name from the approved invoice line). Written only by approve_declaration_extraction; a new approval of the same declaration voids the previous lines (void-only, no DELETE).';
CREATE INDEX IF NOT EXISTS declaration_items_decl_idx ON public.declaration_items (declaration_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS declaration_items_tx_idx ON public.declaration_items (transaction_id) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS public.hs_reference (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  hs_code               text NOT NULL CHECK (hs_code ~ '^[0-9]{2,14}$'),
  description_ar        text CHECK (char_length(description_ar) <= 2000),
  invoice_description   text CHECK (char_length(invoice_description) <= 2000),
  scientific_name       text CHECK (char_length(scientific_name) <= 300),
  origin_country        text CHECK (char_length(origin_country) <= 120),
  -- the uniqueness keys (legacy normalizeSearch_ of the two descriptions; '' when empty)
  desc_key              text GENERATED ALWAYS AS (coalesce(app.legacy_search_key(description_ar), '')) STORED,
  invoice_key           text GENERATED ALWAYS AS (coalesce(app.legacy_search_key(invoice_description), '')) STORED,
  last_declaration_id   uuid,
  last_declaration_no   text CHECK (char_length(last_declaration_no) <= 30),
  last_declaration_date date,
  last_transaction_id   uuid,
  last_importer         text CHECK (char_length(last_importer) <= 300),
  usage_count           int NOT NULL DEFAULT 1 CHECK (usage_count >= 1),
  notes                 text CHECK (char_length(notes) <= 500),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_used_by          uuid NOT NULL,
  last_used_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.hs_reference IS 'legacy step 4 «مرجع البنود»: HS codes learned ONLY from customs declarations approved by staff (approve_declaration_extraction), one row per org + HS + Arabic description + invoice description, with the last declaration / importer and a usage count. A suggestion for the reviewer (search_hs_reference), never a tariff decision; a supplier HS code on an invoice never feeds it. Written only by the RPC; no DELETE.';
CREATE UNIQUE INDEX IF NOT EXISTS hs_reference_key_uidx ON public.hs_reference (org_id, hs_code, desc_key, invoice_key);
CREATE INDEX IF NOT EXISTS hs_reference_org_idx ON public.hs_reference (org_id, usage_count DESC);

-- guards: no DELETE; declaration items: only the void columns change, once; an approval is immutable (but its Daftra hook;
-- its result is set once)
CREATE OR REPLACE FUNCTION app.tg_legacy_decl_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'declaration_items' THEN
    IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'voided_at'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason'],
                                to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason'],
                                ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason'])));
  ELSIF TG_TABLE_NAME = 'declaration_approvals' THEN
    -- the result is written once by the approving RPC (inserted '{}', set at the end of the same call)
    IF OLD.result <> '{}'::jsonb AND NEW.result IS DISTINCT FROM OLD.result THEN PERFORM app.fail('MRS_IMMUTABLE', 'result'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD) - ARRAY['daftra_hook','result'], to_jsonb(NEW) - ARRAY['daftra_hook','result'],
                                ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - ARRAY['daftra_hook','result'])));
  ELSIF TG_TABLE_NAME = 'hs_reference' THEN
    -- (the generated keys are not computed yet in a BEFORE trigger: the descriptions they derive from are guarded instead)
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','hs_code','description_ar','invoice_description',
                                                                    'created_by','created_at']);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard ON public.declaration_items;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.declaration_items FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_decl_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.declaration_approvals;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.declaration_approvals FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_decl_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.hs_reference;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.hs_reference FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_decl_guard();
DROP TRIGGER IF EXISTS trg_no_delete ON public.declaration_items;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.declaration_items FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.declaration_approvals;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.declaration_approvals FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.hs_reference;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.hs_reference FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
-- the trail without the document content (app.tg_legacy_docs_audit of 20261119000100: TG_ARGV = keys kept out)
DROP TRIGGER IF EXISTS trg_audit ON public.declaration_approvals;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.declaration_approvals FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('result');
DROP TRIGGER IF EXISTS trg_audit ON public.declaration_items;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.declaration_items FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('hs_code', 'description_ar', 'invoice_description', 'scientific_name', 'quantity', 'unit',
    'value', 'origin_country', 'net_weight_kg', 'gross_weight_kg', 'invoice_number', 'notes', 'void_reason');
DROP TRIGGER IF EXISTS trg_audit ON public.hs_reference;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.hs_reference FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('description_ar', 'invoice_description', 'scientific_name', 'origin_country', 'desc_key',
    'invoice_key', 'last_importer', 'notes');

-- ---------------------------------------------------------------------
-- 4. helpers
-- ---------------------------------------------------------------------
-- legacy billReferenceEquivalent_ (= MarsaDocMatch.blTokens / blEquivalent): the letter runs and digit runs of a B/L
-- reading (western digits, upper case), sorted (C order)
CREATE OR REPLACE FUNCTION app.bl_tokens(p text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(t ORDER BY t COLLATE "C"), '{}'::text[])
    FROM (SELECT m[1] AS t FROM regexp_matches(upper(app.to_western(coalesce(p, ''))), '([A-Z]+|[0-9]+)', 'g') AS m) x
$$;
-- equal search keys (legacy normalizeSearch_), or the same non-empty token multiset in any order (RTL-reordered parts).
-- Marsa: an empty token list never matches (legacy treated two token-less texts as equal).
CREATE OR REPLACE FUNCTION app.bl_equivalent(a text, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN app.legacy_search_key(a) IS NULL OR app.legacy_search_key(b) IS NULL THEN false
    WHEN app.legacy_search_key(a) = app.legacy_search_key(b) THEN true
    ELSE cardinality(app.bl_tokens(a)) > 0 AND app.bl_tokens(a) = app.bl_tokens(b) END
$$;

-- legacy normalizeHsCode_: western digits only; NULL when no digit (Marsa stores codes of 2–14 digits)
CREATE OR REPLACE FUNCTION app.hs_code_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN char_length(d) BETWEEN 2 AND 14 THEN d END
    FROM (SELECT regexp_replace(app.to_western(coalesce(p, '')), '[^0-9]', '', 'g') AS d) x
$$;

-- 'YYYY-MM-DD' → date, anything else (or an impossible day) → NULL
CREATE OR REPLACE FUNCTION app.decl_try_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE s text := btrim(app.to_western(coalesce(p, '')));
BEGIN
  IF s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  BEGIN
    RETURN s::date;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END $$;

-- a customs declaration reading → its draft (legacy normalizeDeclarationDraft_ over the saved reading: reviewed values win
-- over the machine values; the B/L number stays as read, its candidates are kept apart; containers from the per-container
-- rows then container_numbers; items = line_items with an HS code or a description)
CREATE OR REPLACE FUNCTION app.decl_draft_of(e public.document_extractions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(e.extracted_fields, '{}'::jsonb) || coalesce(e.reviewed_fields, '{}'::jsonb);
  dd jsonb := CASE WHEN jsonb_typeof(e.ai_detail -> 'declaration') = 'object' THEN e.ai_detail -> 'declaration' ELSE '{}'::jsonb END;
  v_ctr jsonb; v_items jsonb; v_cand jsonb; v_bl text;
BEGIN
  f := (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(f) AS j(k, v)
         WHERE jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') <> '');
  v_ctr := (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('container_number', x ->> 'container_number',
               'seal_number', left(x ->> 'seal_number', 30), 'size_type', left(x ->> 'size_type', 10),
               'gross_weight', CASE WHEN jsonb_typeof(x -> 'gross_weight') = 'number' THEN x -> 'gross_weight' END)) ORDER BY o), '[]'::jsonb)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.ai_detail -> 'containers') = 'array' THEN e.ai_detail -> 'containers' ELSE '[]'::jsonb END)
                    WITH ORDINALITY AS u(x, o)
              WHERE coalesce(x ->> 'container_number', '') ~ '^[A-Z]{4}[0-9]{7}$');
  v_ctr := v_ctr || (SELECT coalesce(jsonb_agg(jsonb_build_object('container_number', z.c) ORDER BY z.o), '[]'::jsonb)
                       FROM (SELECT c, min(o) AS o FROM unnest(regexp_split_to_array(upper(coalesce(f ->> 'container_numbers', '')), '[,;[:space:]]+'))
                                  WITH ORDINALITY AS u(c, o) WHERE c ~ '^[A-Z]{4}[0-9]{7}$' GROUP BY c) z
                      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ctr) y WHERE y ->> 'container_number' = z.c));
  v_items := (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                 'hs_code', app.hs_code_norm(it ->> 'hs_code'), 'description', left(nullif(btrim(coalesce(it ->> 'description', '')), ''), 2000),
                 'quantity', CASE WHEN jsonb_typeof(it -> 'quantity') = 'number' THEN it -> 'quantity' END,
                 'unit', left(it ->> 'unit', 40),
                 'value', CASE WHEN jsonb_typeof(it -> 'amount') = 'number' THEN it -> 'amount' END,
                 'origin_country', left(it ->> 'origin_country', 120),
                 'net_weight', CASE WHEN jsonb_typeof(it -> 'net_weight') = 'number' THEN it -> 'net_weight' END,
                 'gross_weight', CASE WHEN jsonb_typeof(it -> 'gross_weight') = 'number' THEN it -> 'gross_weight' END,
                 'notes', left(it ->> 'notes', 500))) ORDER BY o), '[]'::jsonb)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.line_items) = 'array' THEN e.line_items ELSE '[]'::jsonb END) WITH ORDINALITY AS u(it, o)
               WHERE jsonb_typeof(it) = 'object'
                 AND (app.hs_code_norm(it ->> 'hs_code') IS NOT NULL OR nullif(btrim(coalesce(it ->> 'description', '')), '') IS NOT NULL));
  v_bl := left(nullif(btrim(f ->> 'bl_number'), ''), 80);
  -- the printed reading first, then the model's other plausible readings (legacy billNoCandidates), each once
  v_cand := (SELECT coalesce(jsonb_agg(to_jsonb(b.c) ORDER BY b.o), '[]'::jsonb)
               FROM (SELECT c, min(o) AS o
                       FROM unnest(ARRAY[v_bl] || ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(dd -> 'bl_candidates') = 'array'
                                                                                             THEN dd -> 'bl_candidates' ELSE '[]'::jsonb END)))
                            WITH ORDINALITY AS u(c, o)
                      WHERE c IS NOT NULL AND btrim(c) <> '' AND char_length(c) <= 80 GROUP BY c) b);
  RETURN jsonb_build_object(
    'declaration_no', left(app.norm_code(f ->> 'declaration_number'), 30),
    'declaration_type', app.norm_declaration_type(f ->> 'declaration_type'),
    'type_evidence', dd ->> 'type_evidence',
    'status', app.norm_declaration_status(f ->> 'declaration_status'),
    'status_raw', coalesce(dd ->> 'status_raw', f ->> 'declaration_status'),
    'declaration_date', app.decl_try_date(f ->> 'declaration_date'),
    'declaration_date_hijri', app.norm_hijri_date(f ->> 'declaration_date_hijri'),
    'date_printed', dd ->> 'date_printed', 'date_from_hijri', dd ->> 'date_from_hijri',
    'hijri_supported', CASE WHEN jsonb_typeof(dd -> 'hijri_supported') = 'boolean' THEN dd -> 'hijri_supported' END,
    'importer_name_ar', f ->> 'importer_name_ar', 'broker_name', f ->> 'broker_name', 'consignee_name', f ->> 'consignee_name',
    'bl_number', v_bl, 'bl_candidates', v_cand,
    'bl_rtl_affected', CASE WHEN jsonb_typeof(dd -> 'bl_rtl_affected') = 'boolean' THEN dd -> 'bl_rtl_affected' ELSE 'false'::jsonb END,
    'vessel', f ->> 'vessel', 'voyage', f ->> 'voyage', 'country_of_origin', f ->> 'country_of_origin',
    'port_of_loading', f ->> 'port_of_loading', 'port_of_discharge', f ->> 'port_of_discharge',
    'invoice_number', f ->> 'invoice_number', 'invoice_value', app.doc_num(f -> 'total'), 'currency', upper(f ->> 'currency'),
    'local_value', app.doc_num(f -> 'local_value'), 'payment_method', f ->> 'payment_method',
    'packages_count', app.doc_num(f -> 'packages_count'), 'package_type', f ->> 'package_type',
    'gross_weight', app.doc_num(f -> 'gross_weight'), 'net_weight', app.doc_num(f -> 'net_weight'),
    'goods_description', f ->> 'goods_description',
    'containers', v_ctr, 'items', v_items);
END $$;

-- the draft ↔ the transaction (legacy compareDeclarationWithTransaction_ + the Marsa declaration rules) →
-- {bl {status match | mismatch | no_transaction_bl | not_read, transaction_bls, candidates, matched_with, rtl_affected},
--  containers {matched, new, not_on_declaration, on_other_tx}, declaration {action add | correct | conflict, existing},
--  status {read, current, direction initial | forward | same | backward | unknown}, missing [..],
--  conflicts [{code, blocking, confirmable}], can_approve}
CREATE OR REPLACE FUNCTION app.decl_compare(p_tx public.transactions, d jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_bls text[]; v_cands text[]; v_hit text; v_bl_status text; v_tx_ctr text[]; v_decl_ctr text[]; v_act public.customs_declarations;
  v_order text[] := ARRAY['draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',
                          'release_ready','released'];
  v_dir text; v_action text; v_conf jsonb := '[]'::jsonb; v_miss text[] := '{}'; v_no text := d ->> 'declaration_no';
  v_st text := d ->> 'status'; v_twin text[] := '{}';
BEGIN
  v_bls := ARRAY(SELECT DISTINCT n FROM (SELECT bl.bl_number AS n FROM public.transaction_bls tb JOIN public.bills_of_lading bl ON bl.id = tb.bl_id
                                          WHERE tb.transaction_id = p_tx.id
                                         UNION ALL SELECT p_tx.bl_number) z WHERE n IS NOT NULL ORDER BY n);
  v_cands := ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(d -> 'bl_candidates') = 'array' THEN d -> 'bl_candidates' ELSE '[]'::jsonb END));
  IF d ->> 'bl_number' IS NOT NULL AND NOT ((d ->> 'bl_number') = ANY (v_cands)) THEN v_cands := ARRAY[d ->> 'bl_number'] || v_cands; END IF;
  SELECT c INTO v_hit FROM unnest(v_cands) WITH ORDINALITY AS u(c, o)
   WHERE EXISTS (SELECT 1 FROM unnest(v_bls) b WHERE app.bl_equivalent(b, c)) ORDER BY o LIMIT 1;
  v_bl_status := CASE WHEN cardinality(v_cands) = 0 THEN 'not_read' WHEN cardinality(v_bls) = 0 THEN 'no_transaction_bl'
                      WHEN v_hit IS NOT NULL THEN 'match' ELSE 'mismatch' END;
  IF v_bl_status = 'mismatch' THEN
    v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'bl_mismatch', 'blocking', true, 'confirmable', true));
  END IF;

  v_tx_ctr := ARRAY(SELECT k.container_no FROM public.containers k WHERE k.transaction_id = p_tx.id ORDER BY k.container_no);
  v_decl_ctr := ARRAY(SELECT x ->> 'container_number' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d -> 'containers') = 'array'
                        THEN d -> 'containers' ELSE '[]'::jsonb END) x WHERE x ->> 'container_number' IS NOT NULL);
  IF p_tx.cargo_unit_type = 'roro' AND cardinality(v_decl_ctr) > 0 THEN
    v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'containers_roro', 'blocking', true, 'confirmable', false));
  END IF;
  -- review fix: the step-2 duplicate rule under the DECLARATION's own B/L (as printed + its candidates), not only the
  -- transaction's: a container of the declaration already on another live transaction under that B/L is the same shipment
  -- twice (the containers trigger keys on the target transaction's B/L and skips a transaction without one). Only the
  -- declaration's container numbers are reported (never the other transaction).
  IF p_tx.cargo_unit_type IS DISTINCT FROM 'roro' AND cardinality(v_decl_ctr) > 0 THEN
    v_twin := ARRAY(SELECT DISTINCT x.unit FROM unnest(v_cands) c, app.tx_dup_conflicts(p_tx.org_id, p_tx.id, c, 'container', NULL, v_decl_ctr) x
                     ORDER BY 1);
    IF cardinality(v_twin) > 0 THEN
      v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'shipment_on_other_tx', 'blocking', true, 'confirmable', false));
    END IF;
  END IF;

  SELECT * INTO v_act FROM public.customs_declarations x
   WHERE x.transaction_id = p_tx.id AND x.status NOT IN ('cancelled','replaced') ORDER BY x.created_at DESC, x.id DESC LIMIT 1;
  v_action := CASE WHEN v_act.id IS NULL THEN 'add' WHEN v_no IS NULL OR v_act.declaration_no = v_no THEN 'correct' ELSE 'conflict' END;
  IF v_action = 'conflict' THEN
    v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'declaration_other_number', 'blocking', true, 'confirmable', false));
  END IF;
  IF v_no IS NOT NULL AND (EXISTS (SELECT 1 FROM public.customs_declarations x WHERE x.org_id = p_tx.org_id AND x.declaration_no = v_no
                                     AND x.status NOT IN ('cancelled','replaced') AND x.transaction_id <> p_tx.id)
                           OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.org_id = p_tx.org_id AND t.declaration_no = v_no AND t.id <> p_tx.id)) THEN
    v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'declaration_no_taken', 'blocking', true, 'confirmable', false));
  END IF;
  v_dir := CASE WHEN v_st IS NULL THEN 'unknown' WHEN v_act.id IS NULL THEN 'initial'
                WHEN v_act.status = v_st THEN 'same'
                WHEN array_position(v_order, v_st) > array_position(v_order, v_act.status) THEN 'forward' ELSE 'backward' END;
  IF v_dir = 'backward' THEN
    v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'status_backward', 'blocking', false, 'confirmable', false));
  END IF;
  -- legacy normalizeDeclarationDraft_ (hijriDate && !convertedGregorian): no calendar on the reader, or a Hijri day that
  -- does not exist (review fix: not only hijri_supported = false)
  IF d ->> 'declaration_date_hijri' IS NOT NULL AND d ->> 'date_from_hijri' IS NULL THEN
    v_conf := v_conf || jsonb_build_array(jsonb_build_object('code', 'hijri_unverified', 'blocking', false, 'confirmable', false));
  END IF;

  IF v_no IS NULL THEN v_miss := v_miss || 'declaration_no'::text; END IF;
  IF d ->> 'declaration_type' IS NULL THEN v_miss := v_miss || 'declaration_type'::text; END IF;
  IF d ->> 'declaration_date' IS NULL THEN v_miss := v_miss || 'declaration_date'::text; END IF;
  IF v_st IS NULL OR NOT (v_st = ANY (v_order)) THEN v_miss := v_miss || 'status'::text; END IF;
  IF cardinality(v_decl_ctr) = 0 AND p_tx.cargo_unit_type IS DISTINCT FROM 'roro' THEN v_miss := v_miss || 'containers'::text; END IF;

  RETURN jsonb_build_object(
    'bl', jsonb_build_object('status', v_bl_status, 'transaction_bls', to_jsonb(v_bls), 'candidates', to_jsonb(v_cands),
                             'matched_with', v_hit, 'rtl_affected', coalesce(d -> 'bl_rtl_affected', 'false'::jsonb)),
    'containers', jsonb_build_object(
      'matched', to_jsonb(ARRAY(SELECT c FROM unnest(v_decl_ctr) c WHERE c = ANY (v_tx_ctr))),
      'new', to_jsonb(ARRAY(SELECT c FROM unnest(v_decl_ctr) c WHERE NOT (c = ANY (v_tx_ctr)))),
      'not_on_declaration', to_jsonb(ARRAY(SELECT c FROM unnest(v_tx_ctr) c WHERE NOT (c = ANY (v_decl_ctr)))),
      'on_other_tx', to_jsonb(v_twin)),
    'declaration', jsonb_build_object('action', v_action, 'existing', CASE WHEN v_act.id IS NULL THEN NULL ELSE app.decl_json(v_act) END),
    'status', jsonb_build_object('read', v_st, 'current', v_act.status, 'direction', v_dir),
    'missing', to_jsonb(v_miss), 'conflicts', v_conf,
    'can_approve', cardinality(v_miss) = 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_conf) c
                                                           WHERE (c ->> 'blocking')::boolean AND NOT (c ->> 'confirmable')::boolean));
END $$;

-- the optimistic version of a review: changes when the reading, the transaction, its containers / B/Ls / declarations or the
-- approvals of the reading change (approve_declaration_extraction refuses a stale one: MRS_DECL_STALE)
CREATE OR REPLACE FUNCTION app.decl_review_version(e public.document_extractions, p_tx public.transactions) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT md5(jsonb_build_object(
    'e', jsonb_build_array(e.id, e.review_status, e.reviewed_fields, e.voided_at, e.transaction_id),
    't', jsonb_build_array(p_tx.id, p_tx.updated_at, p_tx.bl_number, p_tx.cargo_unit_type),
    'c', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.container_no, k.seal_no, k.size_type, k.gross_weight_kg) ORDER BY k.container_no), '[]'::jsonb)
            FROM public.containers k WHERE k.transaction_id = p_tx.id),
    'b', (SELECT coalesce(jsonb_agg(jsonb_build_array(bl.bl_number, bl.vessel, tb.is_primary) ORDER BY bl.bl_number), '[]'::jsonb)
            FROM public.transaction_bls tb JOIN public.bills_of_lading bl ON bl.id = tb.bl_id WHERE tb.transaction_id = p_tx.id),
    'd', (SELECT coalesce(jsonb_agg(jsonb_build_array(x.id, x.declaration_no, x.status, x.declaration_type, x.declaration_date,
                                                      x.declaration_date_hijri, x.updated_at) ORDER BY x.created_at, x.id), '[]'::jsonb)
            FROM public.customs_declarations x WHERE x.transaction_id = p_tx.id),
    'a', (SELECT count(*) FROM public.declaration_approvals a WHERE a.extraction_id = e.id))::text)
$$;

-- legacy upsertHsReferenceFromDeclaration_: one row per org + HS + Arabic description + invoice description; a repeat
-- raises usage_count and moves the «last» columns to this declaration → the row id
CREATE OR REPLACE FUNCTION app.hs_reference_learn(p_org uuid, p_hs text, p_desc text, p_inv text, p_sci text, p_origin text,
                                                  p_decl public.customs_declarations, p_importer text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.hs_reference AS h (org_id, hs_code, description_ar, invoice_description, scientific_name, origin_country,
    last_declaration_id, last_declaration_no, last_declaration_date, last_transaction_id, last_importer, usage_count,
    created_by, last_used_by, last_used_at)
  VALUES (p_org, p_hs, left(p_desc, 2000), left(p_inv, 2000), left(p_sci, 300), left(p_origin, 120), p_decl.id, p_decl.declaration_no,
          p_decl.declaration_date, p_decl.transaction_id, left(p_importer, 300), 1, auth.uid(), auth.uid(), now())
  ON CONFLICT (org_id, hs_code, desc_key, invoice_key) DO UPDATE SET
    usage_count = h.usage_count + 1,
    scientific_name = coalesce(EXCLUDED.scientific_name, h.scientific_name),
    origin_country = coalesce(EXCLUDED.origin_country, h.origin_country),
    last_declaration_id = EXCLUDED.last_declaration_id, last_declaration_no = EXCLUDED.last_declaration_no,
    last_declaration_date = EXCLUDED.last_declaration_date, last_transaction_id = EXCLUDED.last_transaction_id,
    last_importer = coalesce(EXCLUDED.last_importer, h.last_importer), last_used_by = EXCLUDED.last_used_by, last_used_at = now()
  RETURNING h.id INTO v_id;
  RETURN v_id;
END $$;

-- legacy mergeNotes_: the existing notes, then the new lines not already there (each once, in order), ≤ 2000 characters
CREATE OR REPLACE FUNCTION app.decl_merge_notes(p_old text, p_new text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT left(nullif(string_agg(z.l, E'\n' ORDER BY z.o), ''), 2000)
    FROM (SELECT btrim(l) AS l, min(o) AS o
            FROM unnest(regexp_split_to_array(concat_ws(E'\n', p_old, p_new), E'\n')) WITH ORDINALITY AS u(l, o)
           WHERE btrim(l) <> '' GROUP BY btrim(l)) z
$$;

-- the reading of a declaration approval: loaded, visible to the caller's org, of the declaration kind, not voided
CREATE OR REPLACE FUNCTION app.decl_reading(p_extraction uuid, p_tx public.transactions) RETURNS public.document_extractions
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.document_extractions; v_btx uuid;
BEGIN
  SELECT * INTO e FROM public.document_extractions x WHERE x.id = p_extraction;
  IF e.id IS NULL OR e.org_id <> p_tx.org_id THEN PERFORM app.fail('MRS_NOT_FOUND', 'extraction'); END IF;
  IF e.transaction_id IS NOT NULL AND e.transaction_id <> p_tx.id THEN PERFORM app.fail('MRS_INVALID', 'transaction_id'); END IF;
  IF e.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_DOC_VOIDED', 'extraction'); END IF;
  IF e.doc_type <> 'customs_declaration'
     AND NOT coalesce(jsonb_typeof(e.ai_detail -> 'detected_documents') = 'array' AND (e.ai_detail -> 'detected_documents') ? 'customs_declaration', false) THEN
    PERFORM app.fail('MRS_MATCH_DOC_KIND', 'customs_declaration');
  END IF;
  -- review fix (legacy assertExpectedDocumentType_('declaration', …)): an AI reading whose detected type is not a customs
  -- declaration (another document, or 'other') is the wrong file, whatever doc_type it was saved under — unless the file
  -- also holds a declaration (detected_documents). A reading without a detected type (manual / OCR) is trusted.
  IF coalesce(e.ai_detail ->> 'detected_type', 'customs_declaration') <> 'customs_declaration'
     AND NOT coalesce(jsonb_typeof(e.ai_detail -> 'detected_documents') = 'array' AND (e.ai_detail -> 'detected_documents') ? 'customs_declaration', false) THEN
    PERFORM app.fail('MRS_MATCH_DOC_KIND', 'customs_declaration');
  END IF;
  -- a reading sitting in a step-3 document batch: the batch's transaction (when it has one) is the only target
  SELECT b.transaction_id INTO v_btx FROM public.doc_batch_documents bd JOIN public.doc_batches b ON b.id = bd.batch_id
   WHERE bd.extraction_id = e.id AND bd.detached_at IS NULL AND b.status IN ('draft','approved') AND b.transaction_id IS NOT NULL
   ORDER BY bd.created_at DESC LIMIT 1;
  IF v_btx IS NOT NULL AND v_btx <> p_tx.id THEN PERFORM app.fail('MRS_INVALID', 'transaction_id'); END IF;
  RETURN e;
END $$;

-- ---------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------
-- get_declaration_review(p_extraction, p_tx) — staff of the transaction's branch → {extraction_id, transaction_id, ref,
-- batch_id, approval | null, draft, comparison (app.decl_compare), version}. Read-only: nothing is saved or approved.
CREATE OR REPLACE FUNCTION public.get_declaration_review(p_extraction uuid, p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; e public.document_extractions; v_d jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NULL OR NOT app.has_tx_role(p_tx, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  e := app.decl_reading(p_extraction, v_tx);
  v_d := app.decl_draft_of(e);
  RETURN jsonb_build_object(
    'extraction_id', e.id, 'transaction_id', v_tx.id, 'ref', v_tx.ref, 'cargo_unit_type', v_tx.cargo_unit_type,
    'batch_id', (SELECT bd.batch_id FROM public.doc_batch_documents bd WHERE bd.extraction_id = e.id AND bd.detached_at IS NULL
                  ORDER BY bd.created_at DESC LIMIT 1),
    'review_status', e.review_status, 'prompt_version', e.ai_detail ->> 'prompt_version',
    'approval', (SELECT to_jsonb(a) - 'result' FROM public.declaration_approvals a WHERE a.extraction_id = e.id),
    'draft', v_d, 'comparison', app.decl_compare(v_tx, v_d), 'version', app.decl_review_version(e, v_tx));
END $$;

-- approve_declaration_extraction(p_extraction, p_tx, {version (required: get_declaration_review.version), declaration_no?,
--   declaration_type?, declaration_date?, declaration_date_hijri?, status?, containers? [{container_number, seal_number?,
--   size_type?, gross_weight?}], items? [{hs_code?, description?, invoice_description?, scientific_name?, quantity?, unit?,
--   value?, origin_country?, net_weight?, gross_weight?, invoice_number?, notes?}], vessel?, notes?, confirm_bl_mismatch?,
--   idempotencyKey?}) — an ops writer of the transaction's branch approves the staff-reviewed draft of a customs declaration
--   reading (a key left out of the payload keeps the reading's value). Atomic:
--   validates the number, type (import / export / clearance), Gregorian date, status (a Fasah stage) and ≥ 1 container
--   (none on a Ro-Ro transaction); the B/L of the transaction is never replaced — a reading that is not token-equivalent to
--   a B/L of the transaction is refused (MRS_DECL_BL_MISMATCH) unless confirm_bl_mismatch; the declaration is added
--   (add_declaration, source 'ocr') or, same number, corrected (correct_declaration: an empty field filled, a differing
--   type / date / Hijri replaced by the reviewed value — declaration_replaced —, the notes merged) and its status moved
--   forward (set_declaration_status; a status behind the recorded one is kept and reported); another active number →
--   MRS_DECL_NUMBER_CONFLICT (cancel / replace it first); the primary B/L vessel and the origin country only when empty
--   (tx_filled / tx_kept), the transaction's declaration notes merged; containers merged by number (source 'declaration'
--   on the rows added) through the step-2 duplicate guard, also under the declaration's own B/L (a duplicate rolls
--   everything back: MRS_DUPLICATE_TX container); declaration_items written (previous lines of the
--   declaration voided); hs_reference learned; the reading linked + marked reviewed; declaration_approvals row + the
--   declaration event op 'approved' (the step-7 Daftra hook, daftra_hook 'deferred'). Idempotent (the hash includes the
--   reading and the transaction); a stale version → MRS_DECL_STALE; a reading approved once → MRS_DECL_ALREADY_APPROVED.
CREATE OR REPLACE FUNCTION public.approve_declaration_extraction(p_extraction uuid, p_tx uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_key uuid; v_replay jsonb; v_tx public.transactions; e public.document_extractions;
  v_d jsonb; v_cmp jsonb; v_no text; v_type text; v_date date; v_hijri text; v_st text; v_s text; v_ctr jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb; c jsonb; it jsonb; v_cur public.containers; v_added text[] := '{}'; v_upd text[] := '{}';
  v_same text[] := '{}'; v_decl public.customs_declarations; v_act public.customs_declarations; v_action text; v_st_action text;
  v_fix jsonb := '{}'::jsonb; v_filled text[] := '{}'; v_kept text[] := '{}'; v_bl_status text; v_notes text; v_vessel text;
  v_pbl public.bills_of_lading; v_batch uuid; v_appr uuid; v_n_items int := 0; v_hs uuid[] := '{}'; v_h uuid; v_inv record;
  v_line int := 0; v_importer text; v_res jsonb; v_order text[] := ARRAY['draft','submitted','accepted','under_inspection',
  'cco_review_done','awaiting_duty_payment','release_ready','released']; v_warn text[] := '{}'; v_n numeric;
  v_d0 jsonb; v_repl text[] := '{}'; v_merged text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_tx := app.g3_lock_tx(p_tx, app.ops_writer_roles());
  PERFORM app.only_keys(p, ARRAY['version','declaration_no','declaration_type','declaration_date','declaration_date_hijri','status',
                                 'containers','items','vessel','notes','confirm_bl_mismatch','idempotencyKey']);
  v_key := app.idem_key_from(p);
  -- the reading and the transaction are part of the hashed request: a key reused for another pair is a conflict
  v_replay := app.idem_begin('approve_declaration_extraction', v_key,
                             jsonb_build_object('extraction', p_extraction, 'transaction', p_tx, 'p', p - 'idempotencyKey'), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  e := app.decl_reading(p_extraction, v_tx);
  SELECT * INTO e FROM public.document_extractions x WHERE x.id = e.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.declaration_approvals a WHERE a.extraction_id = e.id) THEN
    PERFORM app.fail('MRS_DECL_ALREADY_APPROVED');
  END IF;
  IF jsonb_typeof(p -> 'version') IS DISTINCT FROM 'string' OR btrim(p ->> 'version') = '' THEN PERFORM app.fail('MRS_REQUIRED', 'version'); END IF;
  IF p ->> 'version' <> app.decl_review_version(e, v_tx) THEN PERFORM app.fail('MRS_DECL_STALE'); END IF;

  -- the reviewed draft: the reading's values, overridden by the reviewer's
  v_d := app.decl_draft_of(e);
  v_d0 := v_d;
  IF p ? 'declaration_no' THEN v_d := v_d || jsonb_build_object('declaration_no', app.norm_code(app.ptext(p, 'declaration_no', 60))); END IF;
  IF p ? 'declaration_type' THEN
    v_s := app.ptext(p, 'declaration_type', 40);
    IF v_s IS NOT NULL AND app.norm_declaration_type(v_s) IS NULL THEN PERFORM app.fail('MRS_INVALID', 'declaration_type'); END IF;
    v_d := v_d || jsonb_build_object('declaration_type', app.norm_declaration_type(v_s));
  END IF;
  IF p ? 'declaration_date' THEN v_d := v_d || jsonb_build_object('declaration_date', app.pdate(p, 'declaration_date')); END IF;
  IF p ? 'declaration_date_hijri' THEN
    v_s := app.ptext(p, 'declaration_date_hijri', 20);
    IF v_s IS NOT NULL AND app.norm_hijri_date(v_s) IS NULL THEN PERFORM app.fail('MRS_INVALID', 'declaration_date_hijri'); END IF;
    v_d := v_d || jsonb_build_object('declaration_date_hijri', app.norm_hijri_date(v_s));
  END IF;
  IF p ? 'status' THEN
    v_s := app.ptext(p, 'status', 200);
    IF v_s IS NOT NULL AND NOT (coalesce(app.norm_declaration_status(v_s), '') = ANY (v_order)) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    v_d := v_d || jsonb_build_object('status', app.norm_declaration_status(v_s));
  END IF;
  IF p ? 'vessel' THEN v_d := v_d || jsonb_build_object('vessel', app.ptext(p, 'vessel', 80)); END IF;
  IF p ? 'containers' THEN
    IF jsonb_typeof(p -> 'containers') <> 'array' OR jsonb_array_length(p -> 'containers') > 300 THEN PERFORM app.fail('MRS_INVALID', 'containers'); END IF;
    FOR c IN SELECT y FROM jsonb_array_elements(p -> 'containers') y LOOP
      IF jsonb_typeof(c) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'containers'); END IF;
      PERFORM app.only_keys(c, ARRAY['container_number','seal_number','size_type','gross_weight']);
      v_s := upper(regexp_replace(app.to_western(coalesce(c ->> 'container_number', '')), '[^A-Za-z0-9]', '', 'g'));
      IF v_s !~ '^[A-Z]{4}[0-9]{7}$' THEN PERFORM app.fail('MRS_INVALID', 'container_number'); END IF;
      CONTINUE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_ctr) z WHERE z ->> 'container_number' = v_s);
      v_ctr := v_ctr || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('container_number', v_s,
        'seal_number', app.ptext(c, 'seal_number', 30), 'size_type', app.ptext(c, 'size_type', 10),
        'gross_weight', app.pnum(c, 'gross_weight', 500000000))));
    END LOOP;
    v_d := v_d || jsonb_build_object('containers', v_ctr);
  END IF;
  IF p ? 'items' THEN
    IF jsonb_typeof(p -> 'items') <> 'array' OR jsonb_array_length(p -> 'items') > 500 THEN PERFORM app.fail('MRS_INVALID', 'items'); END IF;
    FOR it IN SELECT y FROM jsonb_array_elements(p -> 'items') y LOOP
      IF jsonb_typeof(it) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'items'); END IF;
      PERFORM app.only_keys(it, ARRAY['hs_code','description','invoice_description','scientific_name','quantity','unit','value',
                                      'origin_country','net_weight','gross_weight','invoice_number','notes']);
      v_s := app.ptext(it, 'hs_code', 40);
      IF v_s IS NOT NULL AND app.hs_code_norm(v_s) IS NULL THEN PERFORM app.fail('MRS_INVALID', 'hs_code'); END IF;
      CONTINUE WHEN v_s IS NULL AND app.ptext(it, 'description', 2000) IS NULL;
      v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('hs_code', app.hs_code_norm(v_s),
        'description', app.ptext(it, 'description', 2000), 'invoice_description', app.ptext(it, 'invoice_description', 2000),
        'scientific_name', app.ptext(it, 'scientific_name', 300), 'quantity', app.pnum(it, 'quantity', 1e15),
        'unit', app.ptext(it, 'unit', 40), 'value', app.pnum(it, 'value', 1e15), 'origin_country', app.ptext(it, 'origin_country', 120),
        'net_weight', app.pnum(it, 'net_weight', 500000000), 'gross_weight', app.pnum(it, 'gross_weight', 500000000),
        'invoice_number', app.ptext(it, 'invoice_number', 120), 'notes', app.ptext(it, 'notes', 500))));
    END LOOP;
    v_d := v_d || jsonb_build_object('items', v_items);
  END IF;

  -- legacy saveReviewedDeclaration checks (+ Marsa: a Ro-Ro transaction takes no container)
  v_no := v_d ->> 'declaration_no';
  v_type := v_d ->> 'declaration_type';
  v_date := (v_d ->> 'declaration_date')::date;
  v_hijri := v_d ->> 'declaration_date_hijri';
  v_st := v_d ->> 'status';
  IF v_no IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_no'); END IF;
  IF char_length(v_no) > 30 THEN PERFORM app.fail('MRS_TOO_LONG', 'declaration_no'); END IF;
  IF v_type IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_type'); END IF;
  IF v_date IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_date'); END IF;
  IF v_st IS NULL OR NOT (v_st = ANY (v_order)) THEN PERFORM app.fail('MRS_REQUIRED', 'status'); END IF;
  v_ctr := CASE WHEN jsonb_typeof(v_d -> 'containers') = 'array' THEN v_d -> 'containers' ELSE '[]'::jsonb END;
  IF v_tx.cargo_unit_type = 'roro' AND jsonb_array_length(v_ctr) > 0 THEN PERFORM app.fail('MRS_INVALID', 'containers_roro'); END IF;
  IF v_tx.cargo_unit_type IS DISTINCT FROM 'roro' AND jsonb_array_length(v_ctr) = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'containers'); END IF;

  v_cmp := app.decl_compare(v_tx, v_d);
  v_bl_status := v_cmp #>> '{bl,status}';
  IF v_bl_status = 'mismatch' THEN
    IF NOT coalesce(app.pbool(p, 'confirm_bl_mismatch'), false) THEN PERFORM app.fail('MRS_DECL_BL_MISMATCH'); END IF;
    v_bl_status := 'mismatch_confirmed';
  END IF;
  IF v_cmp #>> '{declaration,action}' = 'conflict' THEN PERFORM app.fail('MRS_DECL_NUMBER_CONFLICT'); END IF;
  -- review fix: the step-2 duplicate rule under the declaration's own B/L (printed + candidates) too — one writer per B/L key
  -- (app.tx_dup_lock, in key order), then app.decl_compare's on_other_tx: the same B/L + container on another live
  -- transaction → MRS_DUPLICATE_TX container (also when the transaction has no B/L or the mismatch was confirmed)
  IF v_tx.cargo_unit_type IS DISTINCT FROM 'roro' AND jsonb_array_length(v_ctr) > 0 THEN
    PERFORM app.tx_dup_lock(v_tx.org_id, lk.bl)
       FROM (SELECT min(z.v) AS bl, app.legacy_search_key(z.v) AS bk FROM jsonb_array_elements_text(v_cmp #> '{bl,candidates}') AS z(v)
              WHERE app.legacy_search_key(z.v) IS NOT NULL GROUP BY 2 ORDER BY 2) lk;
    v_cmp := app.decl_compare(v_tx, v_d);
    IF jsonb_array_length(coalesce(v_cmp #> '{containers,on_other_tx}', '[]'::jsonb)) > 0 THEN PERFORM app.fail('MRS_DUPLICATE_TX', 'container'); END IF;
  END IF;

  -- the notes of this reading (legacy: the RTL note; the original B/L is kept)
  v_notes := nullif(concat_ws(E'\n',
    app.ptext(p, 'notes', 1000),
    CASE WHEN (v_d ->> 'bl_rtl_affected')::boolean THEN 'رقم البوليصة في البيان قد يكون متأثرًا باتجاه RTL؛ تم الإبقاء على رقم البوليصة الأصلي.' END,
    CASE WHEN v_bl_status = 'mismatch_confirmed' THEN 'رقم البوليصة في البيان لا يطابق بوليصة المعاملة؛ أكد الموظف الاعتماد وبقي رقم البوليصة الأصلي.' END,
    CASE WHEN v_d ->> 'status_raw' IS NOT NULL AND app.norm_declaration_status(v_d ->> 'status_raw') IS NULL
         THEN 'حالة البيان الأصلية المقروءة: ' || left(v_d ->> 'status_raw', 200) END,
    -- review fix: the date notes of legacy normalizeDeclarationDraft_ (the reading's Gregorian date recomputed from its Hijri;
    -- a Hijri date the reader could not convert, kept unchanged by the reviewer)
    CASE WHEN v_hijri IS NOT NULL AND v_hijri = v_d0 ->> 'declaration_date_hijri'
              AND app.decl_try_date(v_d0 ->> 'date_from_hijri') = v_date AND app.decl_try_date(v_d0 ->> 'date_printed') IS NOT NULL
              AND app.decl_try_date(v_d0 ->> 'date_printed') <> v_date
         THEN 'تم تصحيح التاريخ الميلادي من ' || (v_d0 ->> 'date_printed') || ' إلى ' || v_date::text || ' بناءً على التاريخ الهجري ' || v_hijri || '.' END,
    CASE WHEN v_hijri IS NOT NULL AND v_hijri = v_d0 ->> 'declaration_date_hijri' AND v_d0 ->> 'date_from_hijri' IS NULL
         THEN 'تعذر التحقق الآلي من تحويل التاريخ الهجري عند القراءة؛ راجعه الموظف قبل الاعتماد.' END), '');

  -- the declaration (the existing G3 paths: add / correct / status)
  SELECT * INTO v_act FROM public.customs_declarations x
   WHERE x.transaction_id = v_tx.id AND x.status NOT IN ('cancelled','replaced') ORDER BY x.created_at DESC, x.id DESC LIMIT 1;
  IF v_act.id IS NULL THEN
    v_s := public.add_declaration(v_tx.id, jsonb_strip_nulls(jsonb_build_object(
      'declaration_no', v_no, 'declaration_type', v_type, 'declaration_date', v_date::text, 'declaration_date_hijri', v_hijri,
      'status', v_st, 'source', 'ocr', 'notes', v_notes, 'source_document_id', e.document_id)), NULL) ->> 'id';
    SELECT * INTO v_decl FROM public.customs_declarations x WHERE x.id = v_s::uuid;
    v_action := 'added'; v_st_action := 'initial';
  ELSE
    -- review fix (legacy saveReviewedDeclaration wrote the reviewed type / dates): an empty field is filled (tx_filled), a
    -- differing one is replaced by the reviewed value through correct_declaration (declaration_replaced; the
    -- 'corrected' declaration event keeps before / after); the notes are merged (legacy mergeNotes_), never dropped
    IF v_act.declaration_type IS NULL THEN v_fix := v_fix || jsonb_build_object('declaration_type', v_type); v_filled := v_filled || 'declaration_type'::text;
    ELSIF app.norm_declaration_type(v_act.declaration_type) IS DISTINCT FROM v_type THEN
      v_fix := v_fix || jsonb_build_object('declaration_type', v_type); v_repl := v_repl || 'declaration_type'::text;
    END IF;
    IF v_act.declaration_date IS NULL THEN v_fix := v_fix || jsonb_build_object('declaration_date', v_date::text); v_filled := v_filled || 'declaration_date'::text;
    ELSIF v_act.declaration_date <> v_date THEN
      v_fix := v_fix || jsonb_build_object('declaration_date', v_date::text); v_repl := v_repl || 'declaration_date'::text;
    END IF;
    IF v_hijri IS NOT NULL THEN
      IF v_act.declaration_date_hijri IS NULL THEN v_fix := v_fix || jsonb_build_object('declaration_date_hijri', v_hijri); v_filled := v_filled || 'declaration_date_hijri'::text;
      ELSIF v_act.declaration_date_hijri <> v_hijri THEN
        v_fix := v_fix || jsonb_build_object('declaration_date_hijri', v_hijri); v_repl := v_repl || 'declaration_date_hijri'::text;
      END IF;
    END IF;
    v_merged := app.decl_merge_notes(v_act.notes, v_notes);
    IF v_merged IS DISTINCT FROM v_act.notes THEN v_fix := v_fix || jsonb_build_object('notes', v_merged); END IF;
    IF v_fix <> '{}'::jsonb THEN
      PERFORM public.correct_declaration(v_act.id, v_fix, 'اعتماد قراءة البيان الجمركي');
      v_action := 'corrected';
    ELSE
      v_action := 'unchanged';
    END IF;
    IF v_act.status = v_st THEN v_st_action := 'same';
    ELSIF array_position(v_order, v_st) > array_position(v_order, v_act.status) THEN
      PERFORM public.set_declaration_status(v_act.id, v_st, 'اعتماد قراءة البيان الجمركي');
      v_st_action := 'forward';
    ELSE
      v_st_action := 'kept_backward';
      v_warn := v_warn || 'status_backward'::text;
    END IF;
    SELECT * INTO v_decl FROM public.customs_declarations x WHERE x.id = v_act.id;
  END IF;

  -- the transaction: the primary B/L vessel and the declaration notes / origin only when empty
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
  v_vessel := left(v_d ->> 'vessel', 80);
  IF v_vessel IS NOT NULL THEN
    SELECT bl.* INTO v_pbl FROM public.transaction_bls tb JOIN public.bills_of_lading bl ON bl.id = tb.bl_id
     WHERE tb.transaction_id = v_tx.id AND tb.is_primary LIMIT 1;
    IF v_pbl.id IS NULL THEN v_warn := v_warn || 'vessel_no_bl'::text;
    ELSIF v_pbl.vessel IS NULL THEN
      UPDATE public.bills_of_lading bl SET vessel = v_vessel WHERE bl.id = v_pbl.id;
      v_filled := v_filled || 'vessel'::text;
    ELSIF app.legacy_search_key(v_pbl.vessel) IS DISTINCT FROM app.legacy_search_key(v_vessel) THEN v_kept := v_kept || 'vessel'::text;
    END IF;
  END IF;
  -- the transaction's declaration notes: merged (legacy mergeNotes_), reported as filled when they change
  v_merged := app.decl_merge_notes(v_tx.declaration_notes, v_notes);
  IF v_notes IS NOT NULL AND v_merged IS DISTINCT FROM v_tx.declaration_notes THEN v_filled := v_filled || 'declaration_notes'::text; END IF;
  IF v_d ->> 'country_of_origin' IS NOT NULL THEN
    IF v_tx.country IS NULL THEN v_filled := v_filled || 'country'::text;
    ELSIF app.legacy_search_key(v_tx.country) IS DISTINCT FROM app.legacy_search_key(v_d ->> 'country_of_origin') THEN v_kept := v_kept || 'country'::text; END IF;
  END IF;
  IF 'declaration_notes' = ANY (v_filled) OR 'country' = ANY (v_filled) THEN
    UPDATE public.transactions t SET
      declaration_notes = CASE WHEN 'declaration_notes' = ANY (v_filled) THEN v_merged ELSE t.declaration_notes END,
      country = CASE WHEN 'country' = ANY (v_filled) THEN left(v_d ->> 'country_of_origin', 80) ELSE t.country END
     WHERE t.id = v_tx.id RETURNING * INTO v_tx;
  END IF;

  -- containers (source = declaration; the step-2 duplicate guard fires on insert: MRS_DUPLICATE_TX rolls everything back)
  FOR c IN SELECT y FROM jsonb_array_elements(v_ctr) y LOOP
    SELECT * INTO v_cur FROM public.containers k WHERE k.transaction_id = v_tx.id AND k.container_no = c ->> 'container_number' FOR UPDATE;
    IF v_cur.id IS NULL THEN
      INSERT INTO public.containers (org_id, transaction_id, container_no, seal_no, size_type, gross_weight_kg, source)
      VALUES (v_tx.org_id, v_tx.id, c ->> 'container_number', nullif(c ->> 'seal_number', ''), nullif(c ->> 'size_type', ''),
              app.doc_num(c -> 'gross_weight'), 'declaration');
      v_added := v_added || (c ->> 'container_number');
    ELSIF (v_cur.seal_no IS NULL AND nullif(c ->> 'seal_number', '') IS NOT NULL)
       OR (v_cur.size_type IS NULL AND nullif(c ->> 'size_type', '') IS NOT NULL)
       OR (v_cur.gross_weight_kg IS NULL AND app.doc_num(c -> 'gross_weight') IS NOT NULL) THEN
      UPDATE public.containers k SET seal_no = coalesce(k.seal_no, nullif(c ->> 'seal_number', '')),
             size_type = coalesce(k.size_type, nullif(c ->> 'size_type', '')),
             gross_weight_kg = coalesce(k.gross_weight_kg, app.doc_num(c -> 'gross_weight'))
       WHERE k.id = v_cur.id;
      v_upd := v_upd || (c ->> 'container_number');
    ELSE
      v_same := v_same || (c ->> 'container_number');
    END IF;
  END LOOP;

  -- the reading: linked to the transaction (set once) and marked reviewed by the approver
  BEGIN
    UPDATE public.document_extractions x SET transaction_id = v_tx.id,
           review_status = CASE WHEN x.review_status = 'unreviewed' THEN 'reviewed' ELSE x.review_status END
     WHERE x.id = e.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM app.fail('MRS_EXTRACTION_DUPLICATE');
  END;
  SELECT bd.batch_id INTO v_batch FROM public.doc_batch_documents bd WHERE bd.extraction_id = e.id AND bd.detached_at IS NULL
   ORDER BY bd.created_at DESC LIMIT 1;

  -- the approval (audited) — its id is referenced by the items
  INSERT INTO public.declaration_approvals (org_id, transaction_id, extraction_id, declaration_id, batch_id, bl_status, result, approved_by)
  VALUES (v_tx.org_id, v_tx.id, e.id, v_decl.id, v_batch, v_bl_status, '{}'::jsonb, auth.uid())
  RETURNING id INTO v_appr;

  -- items: this approval's lines replace the declaration's previous ones (void-only)
  v_items := CASE WHEN jsonb_typeof(v_d -> 'items') = 'array' THEN v_d -> 'items' ELSE '[]'::jsonb END;
  UPDATE public.declaration_items i SET voided_at = now(), voided_by = auth.uid(), void_reason = 'استُبدلت باعتماد قراءة البيان ' || e.id::text
   WHERE i.declaration_id = v_decl.id AND i.voided_at IS NULL;
  v_importer := coalesce(v_d ->> 'importer_name_ar', v_d ->> 'consignee_name',
                         (SELECT coalesce(cl.name_ar, cl.name_en) FROM public.clients cl WHERE cl.id = v_tx.client_id));
  FOR it IN SELECT y FROM jsonb_array_elements(v_items) y LOOP
    v_line := v_line + 1;
    -- legacy: the invoice description / scientific name of the approved invoice line at the same position (else the first)
    SELECT i.description, i.scientific_name INTO v_inv FROM public.shipment_invoice_items i
     WHERE i.transaction_id = v_tx.id AND i.voided_at IS NULL
     ORDER BY (i.line_no = v_line) DESC, i.line_no LIMIT 1;
    INSERT INTO public.declaration_items (org_id, transaction_id, declaration_id, approval_id, extraction_id, line_no, hs_code, description_ar,
      invoice_description, scientific_name, quantity, unit, value, origin_country, net_weight_kg, gross_weight_kg, invoice_number, notes, created_by)
    VALUES (v_tx.org_id, v_tx.id, v_decl.id, v_appr, e.id, v_line, app.hs_code_norm(it ->> 'hs_code'), left(it ->> 'description', 2000),
      left(coalesce(it ->> 'invoice_description', v_inv.description), 2000), left(coalesce(it ->> 'scientific_name', v_inv.scientific_name), 300),
      app.doc_num(it -> 'quantity'), left(it ->> 'unit', 40), app.doc_num(it -> 'value'),
      left(coalesce(it ->> 'origin_country', v_d ->> 'country_of_origin'), 120), app.doc_num(it -> 'net_weight'), app.doc_num(it -> 'gross_weight'),
      left(coalesce(it ->> 'invoice_number', v_d ->> 'invoice_number'), 120), left(it ->> 'notes', 500), auth.uid());
    v_n_items := v_n_items + 1;
    IF app.hs_code_norm(it ->> 'hs_code') IS NOT NULL THEN
      v_h := app.hs_reference_learn(v_tx.org_id, app.hs_code_norm(it ->> 'hs_code'), it ->> 'description',
               coalesce(it ->> 'invoice_description', v_inv.description), coalesce(it ->> 'scientific_name', v_inv.scientific_name),
               coalesce(it ->> 'origin_country', v_d ->> 'country_of_origin'), v_decl, v_importer);
      IF NOT (v_h = ANY (v_hs)) THEN v_hs := v_hs || v_h; END IF;
    END IF;
  END LOOP;

  v_res := jsonb_build_object(
    'approval_id', v_appr, 'extraction_id', e.id, 'transaction_id', v_tx.id, 'ref', v_tx.ref, 'batch_id', v_batch,
    'declaration', app.decl_json(v_decl), 'declaration_action', v_action, 'status_action', v_st_action,
    'bl', jsonb_build_object('status', v_bl_status, 'transaction_bls', v_cmp #> '{bl,transaction_bls}',
                             'matched_with', v_cmp #> '{bl,matched_with}', 'rtl_affected', v_cmp #> '{bl,rtl_affected}'),
    'containers', jsonb_build_object('added', to_jsonb(v_added), 'updated', to_jsonb(v_upd), 'unchanged', to_jsonb(v_same),
                                     'declared', coalesce((SELECT jsonb_agg(y ->> 'container_number') FROM jsonb_array_elements(v_ctr) y), '[]'::jsonb)),
    'items', v_n_items, 'hs_reference', jsonb_build_object('saved', cardinality(v_hs), 'ids', to_jsonb(v_hs)),
    'tx_filled', to_jsonb(v_filled), 'tx_kept', to_jsonb(v_kept), 'declaration_replaced', to_jsonb(v_repl),
    'warnings', to_jsonb(v_warn), 'daftra_hook', 'deferred');
  UPDATE public.declaration_approvals a SET result = v_res WHERE a.id = v_appr;
  -- the hook for step 7 (Daftra draft on approval): a declaration event, never a Daftra call here
  PERFORM app.decl_event(v_decl, 'approved', NULL, NULL, jsonb_build_object('approval_id', v_appr, 'extraction_id', e.id,
                                                                             'bl_status', v_bl_status, 'daftra_hook', 'deferred'));
  PERFORM app.idem_finish('approve_declaration_extraction', v_key, v_res);
  RETURN v_res;
END $$;

-- get_transaction_declaration(p_tx) — staff of the transaction's branch → {transaction_id, active (decl_json | null),
-- declarations [decl_json, newest first], items [live lines of the active declaration], approvals [{id, extraction_id,
-- declaration_id, batch_id, bl_status, daftra_hook, approved_by, approved_at}], containers [the container numbers of the
-- active declaration as last approved (approve_declaration_extraction result) | null when it was never approved from a
-- reading]} — the declaration part of the Fasah sheet
CREATE OR REPLACE FUNCTION public.get_transaction_declaration(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_act public.customs_declarations;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NULL OR NOT app.has_tx_role(p_tx, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  SELECT * INTO v_act FROM public.customs_declarations x
   WHERE x.transaction_id = p_tx AND x.status NOT IN ('cancelled','replaced') ORDER BY x.created_at DESC, x.id DESC LIMIT 1;
  RETURN jsonb_build_object(
    'transaction_id', p_tx,
    'active', CASE WHEN v_act.id IS NULL THEN NULL ELSE app.decl_json(v_act) END,
    'declarations', coalesce((SELECT jsonb_agg(app.decl_json(x) ORDER BY x.created_at DESC, x.id DESC)
                                FROM public.customs_declarations x WHERE x.transaction_id = p_tx), '[]'::jsonb),
    'items', coalesce((SELECT jsonb_agg(to_jsonb(i) - ARRAY['voided_at','voided_by','void_reason'] ORDER BY i.line_no)
                         FROM public.declaration_items i WHERE i.declaration_id = v_act.id AND i.voided_at IS NULL), '[]'::jsonb),
    'approvals', coalesce((SELECT jsonb_agg(to_jsonb(a) - 'result' ORDER BY a.approved_at DESC)
                             FROM public.declaration_approvals a WHERE a.transaction_id = p_tx), '[]'::jsonb),
    -- review fix: the declaration's own container list (containers.source marks only the rows the approval inserted)
    'containers', (SELECT coalesce(a.result #> '{containers,declared}',
                                   coalesce(a.result #> '{containers,added}', '[]'::jsonb) || coalesce(a.result #> '{containers,updated}', '[]'::jsonb)
                                   || coalesce(a.result #> '{containers,unchanged}', '[]'::jsonb))
                     FROM public.declaration_approvals a WHERE a.declaration_id = v_act.id
                    ORDER BY a.approved_at DESC, a.id DESC LIMIT 1));
END $$;

-- search_hs_reference(p_org, p_q, p_limit 1–30, default 10) — staff of the org; legacy searchHsReference scoring over the
-- normalised (legacy normalizeSearch_) texts: + 100 when the HS code contains the query, + 50 when the row text contains the
-- whole query, + 10 per query word it contains, + min(usage_count, 20); rows without a text / code match are left out
-- (Marsa: the legacy listed every used row). Sorted by score, then usage. A SUGGESTION only (never written anywhere).
-- → {q, items [{id, hs_code, description_ar, invoice_description, scientific_name, origin_country, last_declaration_no,
--    last_declaration_date, last_importer, usage_count, last_used_at, score}], count}. Review fix: the last_* values come
--    from one branch's declaration / transaction: NULL unless the caller is staff of that transaction's branch.
CREATE OR REPLACE FUNCTION public.search_hs_reference(p_org uuid, p_q text, p_limit int DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_q text := btrim(app.legacy_spaces(coalesce(p_q, ''))); v_key text; v_words text[]; v_limit int; v_items jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF char_length(v_q) > 200 THEN PERFORM app.fail('MRS_TOO_LONG', 'q'); END IF;
  v_limit := least(greatest(coalesce(p_limit, 10), 1), 30);
  v_key := app.legacy_search_key(v_q);
  IF v_key IS NULL THEN RETURN jsonb_build_object('q', v_q, 'items', '[]'::jsonb, 'count', 0); END IF;
  v_words := ARRAY(SELECT DISTINCT app.legacy_search_key(w) FROM regexp_split_to_table(v_q, '[[:space:]]+') w WHERE app.legacy_search_key(w) IS NOT NULL);
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.score DESC, r.usage_count DESC, r.hs_code, r.id), '[]'::jsonb) INTO v_items FROM (
    SELECT s.id, s.hs_code, s.description_ar, s.invoice_description, s.scientific_name, s.origin_country,
           CASE WHEN s.vis THEN s.last_declaration_no END AS last_declaration_no,
           CASE WHEN s.vis THEN s.last_declaration_date END AS last_declaration_date,
           CASE WHEN s.vis THEN s.last_importer END AS last_importer,
           s.usage_count, s.last_used_at, s.m + least(s.usage_count, 20) AS score
      FROM (SELECT h.*, (CASE WHEN position(v_key IN coalesce(app.legacy_search_key(h.hs_code), '')) > 0 THEN 100 ELSE 0 END
                         + CASE WHEN position(v_key IN x.hay) > 0 THEN 50 ELSE 0 END
                         + 10 * (SELECT count(*) FROM unnest(v_words) w WHERE position(w IN x.hay) > 0))::int AS m,
                   (h.last_transaction_id IS NOT NULL AND app.has_tx_role(h.last_transaction_id, app.staff_roles())) AS vis
              FROM public.hs_reference h
              CROSS JOIN LATERAL (SELECT coalesce(app.legacy_search_key(concat_ws(' ', h.hs_code, h.description_ar, h.invoice_description,
                                    h.scientific_name, h.origin_country)), '') AS hay) x
             WHERE h.org_id = p_org) s
     WHERE s.m > 0
     ORDER BY s.m + least(s.usage_count, 20) DESC, s.usage_count DESC, s.hs_code, s.id
     LIMIT v_limit) r;
  RETURN jsonb_build_object('q', v_q, 'items', v_items, 'count', jsonb_array_length(v_items));
END $$;

-- the export audit (20261106000100 §5.4): + the Fasah entry sheet (filters: transaction_id). Body otherwise identical.
CREATE OR REPLACE FUNCTION app.rpt_export_keys(p_report text) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT array(SELECT k FROM unnest(CASE p_report
      WHEN 'search' THEN app.rpt_search_keys()
      WHEN 'transactions' THEN app.rpt_search_keys()
      WHEN 'containers' THEN app.rpt_container_keys()
      WHEN 'trips' THEN app.rpt_trip_keys()
      WHEN 'margins' THEN ARRAY['branch_id','client_id','from','to','operational_status','level','currency']
      WHEN 'costs' THEN ARRAY['group_by','from','to','branch_id','client_id','supplier_id','service_code','level','currency','include_overhead']
      WHEN 'fasah_sheet' THEN ARRAY['transaction_id']                                                                   -- DECL
      ELSE ARRAY[]::text[] END) k WHERE k NOT IN ('limit','offset'))
$$;
-- the inline report CHECK of 20261106000100 (default name), re-created as a superset
ALTER TABLE public.report_exports DROP CONSTRAINT IF EXISTS report_exports_report_check;
ALTER TABLE public.report_exports ADD CONSTRAINT report_exports_report_check
  CHECK (report IN ('search','transactions','containers','trips','margins','costs','fasah_sheet'));

-- ---------------------------------------------------------------------
-- 6. conversion lists (20261119000100 §6, re-created): + the 3 tables of this file (test rows, deleted) and their
--    no-delete guards
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
    'public.declaration_approvals', 'public.declaration_items', 'public.hs_reference',                     -- DECL
    'public.parties', 'public.party_ports',
    'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
    'public.demurrage_cases', 'public.operational_exceptions', 'public.operational_alerts',
    -- costs (G4)
    'public.cost_accruals', 'public.cost_adjustments', 'public.cost_allocations', 'public.client_charges',
    'public.charge_collections', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.supplier_payments',
    'public.finance_documents',
    -- billing (G5)
    'public.billing_intents', 'public.billing_intent_lines', 'public.billing_review_items', 'public.billing_sync_jobs',
    'public.billing_sync_attempts', 'public.daftra_client_links', 'public.daftra_mock_accounts',
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
    'public.declaration_approvals:trg_no_delete', 'public.declaration_items:trg_no_delete',                -- DECL
    'public.hs_reference:trg_no_delete'                                                                    -- DECL
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 7. RLS, policies, grants, function privileges
-- ---------------------------------------------------------------------
ALTER TABLE public.declaration_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.declaration_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hs_reference ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.declaration_approvals, public.declaration_items, public.hs_reference FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.declaration_approvals, public.declaration_items TO authenticated;
-- review fix (field hiding, the G3 / G5 / G6b fail-closed column grants): the HS library is org-wide, but its last_* columns
-- (and who used it) come from ONE branch's declaration / transaction — not readable by a direct SELECT (staff of other
-- branches cannot read those declarations); search_hs_reference returns them only to staff of that transaction's branch
DO $colg$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'hs_reference'
     AND NOT (c.column_name = ANY (ARRAY['last_declaration_id','last_declaration_no','last_declaration_date','last_transaction_id',
                                         'last_importer','created_by','last_used_by']));
  REVOKE SELECT ON public.hs_reference FROM authenticated;
  EXECUTE format('GRANT SELECT (%s) ON public.hs_reference TO authenticated', v_cols);
END $colg$;
DROP POLICY IF EXISTS declaration_approvals_select ON public.declaration_approvals;
CREATE POLICY declaration_approvals_select ON public.declaration_approvals FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
DROP POLICY IF EXISTS declaration_items_select ON public.declaration_items;
CREATE POLICY declaration_items_select ON public.declaration_items FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
-- the HS library is the org's knowledge (any branch's staff); clients / other orgs see nothing
DROP POLICY IF EXISTS hs_reference_select ON public.hs_reference;
CREATE POLICY hs_reference_select ON public.hs_reference FOR SELECT TO authenticated USING (app.is_staff(org_id));

-- the field / detail validators stay executable for the CHECK constraints (as in 20261119000100 §7)
REVOKE EXECUTE ON FUNCTION app.extraction_decl_detail_ok(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_decl_detail_ok(jsonb) TO authenticated;
-- pure normalisers: signed-in users and the Edge Functions; never anon (the generated hs_reference keys use legacy_search_key)
REVOKE EXECUTE ON FUNCTION app.bl_tokens(text), app.bl_equivalent(text, text), app.hs_code_norm(text), app.decl_try_date(text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.bl_tokens(text), app.bl_equivalent(text, text), app.hs_code_norm(text), app.decl_try_date(text)
TO authenticated, service_role;
-- internal helpers and trigger functions: SECURITY DEFINER code / triggers only
REVOKE EXECUTE ON FUNCTION app.decl_draft_of(public.document_extractions), app.decl_compare(public.transactions, jsonb),
  app.decl_review_version(public.document_extractions, public.transactions),
  app.hs_reference_learn(uuid, text, text, text, text, text, public.customs_declarations, text),
  app.decl_reading(uuid, public.transactions), app.tg_legacy_decl_guard()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION app.decl_merge_notes(text, text) FROM PUBLIC, anon, authenticated, service_role;
-- the source trigger is SECURITY INVOKER (it must see the real caller role); a trigger needs no EXECUTE grant
REVOKE EXECUTE ON FUNCTION app.tg_containers_source() FROM PUBLIC, anon, authenticated, service_role;
-- the conversion lists stay SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_delete_guards() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.get_declaration_review(uuid, uuid), public.approve_declaration_extraction(uuid, uuid, jsonb),
  public.get_transaction_declaration(uuid), public.search_hs_reference(uuid, text, int)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_declaration_review(uuid, uuid), public.approve_declaration_extraction(uuid, uuid, jsonb),
  public.get_transaction_declaration(uuid), public.search_hs_reference(uuid, text, int)
TO authenticated;
-- re-created functions (extraction_field_keys, extraction_detail_ok, rpt_export_keys, convert_delete_tables,
-- convert_delete_guards): CREATE OR REPLACE keeps their existing privileges; restated above
