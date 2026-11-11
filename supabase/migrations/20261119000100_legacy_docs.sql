-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261119000100 — legacy port, step 3: shipment document batch and approval
-- (حزمة مستندات الشحنة والاعتماد) — docs/online/LEGACY_DOCS_AR.md, plan docs/online/LEGACY_PORT_PLAN_AR.md.
-- Builds on legacy_tx (20261118000100). Database side of step 3 (prompt ai-doc-v3 of the ai-extract Edge Function).
--   P. preflight (legacy_tx applied, save_movement present) + schema_versions row
--   0. dictionaries status_labels: doc_batch_status (draft / approved / discarded / archived), doc_batch_slot
--                   (bill_of_lading / commercial_invoice / packing_list / customs_declaration), client_match_method
--   1. readings     app.extraction_field_keys + the 14 ai-doc-v3 keys (seal_numbers, consignee_name, notify_party, …);
--                   app.extraction_items_ok + the legacy invoice / packing item keys; document_extractions.ai_detail
--                   (machine detail of an ai-doc-v3 reading: prompt version, detected type, per-container rows, field
--                   confidences, warnings; immutable, CHECK app.extraction_detail_ok); app.tg_document_extractions_before
--                   re-created (+ ai_detail immutable) and app.tg_audit re-created (+ ai_detail kept out of the trail)
--   2. parties      + aliases (text[]); app.shipping_agents_template() = the 15 legacy agents (legacy defaultShippingAgents /
--                   MarsaNorm.AGENTS) with aliases; app.seed_shipping_agents(org): adds the missing agents, never a
--                   duplicate of an existing party (same name / alias → only the aliases of an existing shipping agent are
--                   completed); every existing org is seeded here, a new org through public.seed_shipping_agents (admin).
--                   public.match_shipping_agent(org, name).
--   3. tables       public.doc_batches (one shipment's documents: draft → approved | discarded → archived),
--                   public.doc_batch_documents (the slots: one B/L, ≤ 10 invoices, ≤ 10 packing lists, one declaration;
--                   detach = void), public.transaction_shipment_data (the legacy «بيانات فسح» record, one per transaction),
--                   public.shipment_invoice_items / public.shipment_packing_items (void-only: a new approval voids the
--                   previous rows). Read under RLS (staff of the branch / of the transaction's branch); no write grant —
--                   every write goes through the RPCs below; no DELETE; audited without the document content.
--   4. helpers      app.consignee_identity_name (legacy extractCustomerIdentityName_, parity with extract.js identityName),
--                   app.client_latin_key (legacy normalizeCustomerLatinName_), app.doc_batch_draft_check (shape of a
--                   draft), app.doc_batch_compare (legacy buildDocumentComparison_ + seal / container sets + the
--                   required-fields checklist), app.doc_batch_merge (legacy mergeDocumentDrafts_ over the attached
--                   readings, with merge conflict notes), app.client_alias_learn (suggested / approved alias + stats)
--   5. RPCs         create_doc_batch, attach_doc_batch_document (wrong-slot guard on the detected type), detach_doc_batch_document,
--                   merge_doc_batch, save_doc_batch_draft (optimistic version), get_doc_batch, list_pending_doc_batches,
--                   discard_doc_batch, archive_doc_batch, approve_doc_batch (staff: writes the approved draft into an existing
--                   transaction or creates one — B/L through save_bl, containers through the step-2 duplicate guard,
--                   shipment data, invoice / packing items, links the readings; atomic), get_transaction_shipment,
--                   match_client_v2 (consignee cascade with confidence; never links), confirm_client_match (alias learning:
--                   approved only on a staff confirmation), reject_client_alias, seed_shipping_agents, match_shipping_agent
--   6. conversion   app.convert_delete_tables / app.convert_delete_guards re-created with the 5 new tables
--   7. privileges
-- Review fixes (REVIEW markers): the approve idempotency hash includes the batch; a later batch on an approved
-- transaction is laid over its approved draft (transaction_shipment_data.draft, app.doc_draft_overlay = legacy
-- mergeDocumentDrafts_; item lists replaced only when the batch has items); suggested aliases capped at 89; the legacy
-- phonetic / transliteration client scoring (app.cm_*); consignee vs buyer compared on identity names; B/L placeholders
-- dropped (app.doc_bl_no = normalizeValidBillNo_); combined files (ai_detail.detected_documents: any slot of their
-- types, every section filled); the file hash Claude read bound to the usage row (app.ai_usage.source_sha256,
-- public.ai_bind_source service_role, app.tg_ai_usage_guard re-created) and required for an ai-doc-v3 reading.
-- Every AI value stays a DRAFT until a staff member approves it; approval is audited; nothing is approved automatically.
-- Errors: + MRS_DOC_WRONG_SLOT (<slot>:<detected>), MRS_DOC_IN_OTHER_BATCH, MRS_DOC_BATCH_STATE (<status>),
-- MRS_DOC_BATCH_STALE, MRS_CLIENT_ALIAS_CONFLICT; otherwise existing codes.
-- Re-runnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS + CREATE /
-- ON CONFLICT). Re-pasting 20261101000100 / 20261114000100 / 20261116000100 after this file narrows the field / item keys
-- (ai-doc-v3 readings can then not be saved) and drops ai_detail from the guard / audit functions; re-pasting
-- 20261115000100 / 20261116000100 / 20261117000100 drops the new tables from the conversion lists (the conversion then
-- refuses: unclassified_tables): re-paste this file right after.
-- Down-path (staging only): DROP the RPCs of §5 and the app.* helpers of §2 / §4; DROP TABLE public.shipment_packing_items,
-- public.shipment_invoice_items, public.transaction_shipment_data, public.doc_batch_documents, public.doc_batches;
-- ALTER TABLE public.document_extractions DROP COLUMN ai_detail; ALTER TABLE public.parties DROP COLUMN aliases; DROP
-- public.ai_bind_source, app.ai_usage_source_ok, ALTER TABLE app.ai_usage DROP COLUMN source_sha256 and re-paste
-- 20261114000100 §1 (tg_ai_usage_guard); re-paste
-- 20261116000100 §1, 20261114000100 §2 (guard), 20261102000200 §4 (tg_audit) and 20261117000100 §10 (conversion lists).
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261118000100') THEN
    RAISE EXCEPTION 'LEGACY DOCS preflight: apply legacy_tx first (schema_versions lacks 20261118000100 legacy_tx)';
  END IF;
  IF to_regprocedure('public.save_movement(jsonb,uuid)') IS NULL OR to_regprocedure('app.tx_dup_conflicts(uuid,uuid,text,text,text,text[])') IS NULL THEN
    RAISE EXCEPTION 'LEGACY DOCS preflight: public.save_movement / app.tx_dup_conflicts missing (apply 20261118000100 legacy_tx)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261119000100', 'legacy_docs')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('doc_batch_status','draft',1,'مسودة بانتظار الاعتماد','Draft — awaiting approval',false),
  ('doc_batch_status','approved',2,'معتمدة ومنقولة إلى المعاملة','Approved into the transaction',false),
  ('doc_batch_status','discarded',3,'متجاهلة (لم تُنقل)','Discarded (not transferred)',false),
  ('doc_batch_status','archived',4,'مؤرشفة','Archived',false),
  ('doc_batch_slot','bill_of_lading',1,'بوليصة الشحن','Bill of lading',false),
  ('doc_batch_slot','commercial_invoice',2,'الفاتورة التجارية','Commercial invoice',false),
  ('doc_batch_slot','packing_list',3,'بيان التعبئة','Packing list',false),
  ('doc_batch_slot','customs_declaration',4,'البيان الجمركي','Customs declaration',false),
  ('client_match_method','english_name',1,'الاسم الإنجليزي الرسمي','Official English name',false),
  ('client_match_method','alias',2,'اسم بديل معتمد سابقًا','Approved alias',false),
  ('client_match_method','arabic_name',3,'مطابقة الاسم العربي','Arabic name',false),
  ('client_match_method','vat_number',4,'الرقم الضريبي','VAT number',false),
  ('client_match_method','cr_number',5,'السجل التجاري','CR number',false),
  ('client_match_method','similar',6,'تشابه في الاسم (يحتاج مراجعة)','Similar name (review)',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. readings: field / item keys of prompt ai-doc-v3, document_extractions.ai_detail
-- ---------------------------------------------------------------------
-- extraction_field_keys (20261116000100 §1). DOCS: + the 14 keys of ai-doc-v3. A superset: every stored row stays valid.
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban',
               'vessel','voyage','port_of_loading','port_of_discharge','shipper','consignee',
               'gross_weight','net_weight','packages_count','package_type','goods_description','incoterms',
               'seal_numbers','consignee_name','notify_party','booking_number','place_of_receipt',               -- DOCS
               'place_of_delivery','freight_terms','measurement_cbm','temperature_c','shipping_line',              -- DOCS
               'export_country','payment_terms','packing_list_number','packing_list_date']                        -- DOCS
$$;

-- extraction_items_ok (20261101000100 §1). DOCS: + the legacy invoice / packing item keys (a superset).
CREATE OR REPLACE FUNCTION app.extraction_items_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_typeof(p) = 'array'
    AND jsonb_array_length(p) <= 500
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) it
      WHERE jsonb_typeof(it) <> 'object'
         OR EXISTS (SELECT 1 FROM jsonb_each(it) e
                    WHERE NOT (e.key = ANY (ARRAY['description','hs_code','quantity','unit_price','amount',
                                                  'unit','scientific_name','origin_country','net_weight','gross_weight',  -- DOCS
                                                  'packages','container_number','seal_number','notes']))                  -- DOCS
                       OR jsonb_typeof(e.value) NOT IN ('string','number','null')
                       OR char_length(e.value #>> '{}') > 2000))
$$;

-- the machine detail of an ai-doc-v3 reading (extract.js aiDetail): NULL, or {prompt_version, detected_type, detected_documents?, doc_type,
-- containers [{container_number, seal_number, size_type, packages_count, net_weight, gross_weight}], fields [{name,
-- confidence, page, valid}], warnings [{source, code, text, field}]} within size limits
CREATE OR REPLACE FUNCTION app.extraction_detail_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object' AND octet_length(p::text) <= 200000
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
                     WHERE NOT (k = ANY (ARRAY['prompt_version','detected_type','detected_documents','doc_type','containers','fields','warnings'])))
    AND coalesce(p ->> 'prompt_version', '') ~ '^ai-doc-v[0-9]{1,2}$'
    AND (NOT p ? 'detected_type' OR (p ->> 'detected_type') = ANY (ARRAY['bill_of_lading','commercial_invoice','packing_list',
           'customs_declaration','supplier_invoice','other']))
    -- REVIEW: every document type found in a combined file (legacy detectedDocuments)
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
    AND (NOT p ? 'warnings' OR (jsonb_typeof(p -> 'warnings') = 'array' AND jsonb_array_length(p -> 'warnings') <= 60)))
$$;

ALTER TABLE public.document_extractions ADD COLUMN IF NOT EXISTS ai_detail jsonb;
ALTER TABLE public.document_extractions DROP CONSTRAINT IF EXISTS document_extractions_ai_detail_chk;
ALTER TABLE public.document_extractions ADD CONSTRAINT document_extractions_ai_detail_chk CHECK (app.extraction_detail_ok(ai_detail));
COMMENT ON COLUMN public.document_extractions.ai_detail IS 'ai-doc-v3 reading (20261119000100): the machine detail Claude returned besides the field values — prompt version, detected document type (the wrong-slot guard of doc batches), per-container rows (number, seal, size / type, packages, weights), field confidences and warnings. Set once on insert, immutable; a later read of the same file restores it without a new AI call.';

-- REVIEW: the file Claude actually read. The Edge Function computes the SHA-256 of the bytes it sends and binds it to the
-- reservation (public.ai_bind_source, service_role, once, while reserved); an ai-doc-v3 reading can then only be saved
-- under that hash (tg_document_extractions_before), so the no-charge reuse of a stored v3 reading (ai-extract dedupe)
-- serves only what Claude read from those very bytes, never a hash / values chosen by the browser.
ALTER TABLE app.ai_usage ADD COLUMN IF NOT EXISTS source_sha256 text;
ALTER TABLE app.ai_usage DROP CONSTRAINT IF EXISTS ai_usage_source_sha256_chk;
ALTER TABLE app.ai_usage ADD CONSTRAINT ai_usage_source_sha256_chk CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$');

-- tg_ai_usage_guard (20261114000100 §1). DOCS: + the one bind update (reserved → reserved, source_sha256 NULL → set,
-- nothing else); the hash is immutable afterwards (body otherwise identical).
CREATE OR REPLACE FUNCTION app.tg_ai_usage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM app.fail('MRS_APPEND_ONLY', 'ai_usage'); END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'reserved' THEN                                                   -- DOCS
    IF OLD.source_sha256 IS NOT NULL OR NEW.source_sha256 IS NULL                                               -- DOCS
       OR (to_jsonb(OLD) - 'source_sha256') IS DISTINCT FROM (to_jsonb(NEW) - 'source_sha256') THEN             -- DOCS
      PERFORM app.fail('MRS_APPEND_ONLY', 'ai_usage');                                                          -- DOCS
    END IF;                                                                                                     -- DOCS
    RETURN NEW;                                                                                                 -- DOCS
  END IF;                                                                                                       -- DOCS
  IF OLD.status <> 'reserved' OR NEW.status NOT IN ('ok','refused','error') THEN
    PERFORM app.fail('MRS_APPEND_ONLY', 'ai_usage');
  END IF;
  PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','user_id','purpose','reserved_usd','created_at',
    'source_sha256']);                                                                                          -- DOCS
  NEW.settled_at := now();
  RETURN NEW;
END $$;

-- ai_bind_source(p_reservation, p_sha256) — service_role only (the ai-extract Edge Function, prompt ai-doc-v3, after
-- ai_reserve and before the Claude call): the SHA-256 of the file sent to Claude, set once on an open reservation
CREATE OR REPLACE FUNCTION public.ai_bind_source(p_reservation uuid, p_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u app.ai_usage;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', 'source_sha256'); END IF;
  SELECT * INTO u FROM app.ai_usage x WHERE x.id = p_reservation FOR UPDATE;
  IF u.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'reservation'); END IF;
  IF u.purpose <> 'doc_extract' OR u.status <> 'reserved' OR u.source_sha256 IS NOT NULL THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'bound');
  END IF;
  UPDATE app.ai_usage x SET source_sha256 = p_sha256 WHERE x.id = u.id;
  RETURN jsonb_build_object('id', u.id, 'source_sha256', p_sha256);
END $$;

-- the reading's hash is the one bound to its usage row (SECURITY DEFINER: the extraction trigger runs as the caller)
CREATE OR REPLACE FUNCTION app.ai_usage_source_ok(p_usage uuid, p_sha256 text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_usage IS NOT NULL AND p_sha256 IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.ai_usage u WHERE u.id = p_usage AND u.source_sha256 = p_sha256)
$$;

-- tg_document_extractions_before (20261114000100 §2). DOCS: ai_detail joins the immutable list (body otherwise identical).
CREATE OR REPLACE FUNCTION app.tg_document_extractions_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_doc public.documents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.is_api_caller() THEN
      NEW.created_by := auth.uid();
      NEW.created_at := now();
      NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
      NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
      -- AI: the engine name and the usage link go together, and the link must be the caller's own 'ok' reading
      IF NEW.ai_usage_id IS NOT NULL OR NEW.engine = app.ai_model() THEN
        IF NEW.ai_usage_id IS NULL OR NEW.engine IS DISTINCT FROM app.ai_model()
           OR NOT app.ai_usage_claimable(NEW.ai_usage_id, NEW.org_id) THEN
          PERFORM app.fail('MRS_INVALID', 'ai_usage_id');
        END IF;
      END IF;
      -- DOCS: the ai-doc-v3 detail belongs to an AI reading only
      IF NEW.ai_detail IS NOT NULL AND NEW.ai_usage_id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'ai_detail'); END IF;   -- DOCS
      -- REVIEW: an ai-doc-v3 reading is saved under the hash of the bytes Claude read (bound by the Edge Function)
      IF NEW.ai_detail IS NOT NULL AND NOT app.ai_usage_source_ok(NEW.ai_usage_id, NEW.source_sha256) THEN               -- DOCS
        PERFORM app.fail('MRS_INVALID', 'source_sha256');                                                                -- DOCS
      END IF;                                                                                                            -- DOCS
    END IF;
    -- saved already reviewed (edited before the first save) → stamp the reviewer
    IF NEW.review_status <> 'unreviewed' THEN
      NEW.reviewed_by := coalesce(auth.uid(), NEW.reviewed_by);
      NEW.reviewed_at := now();
    END IF;
  ELSE
    IF app.is_api_caller() THEN
      IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'voided_at'); END IF;
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
        'id','org_id','source_name','source_sha256','source_mime','source_size','source_pages',
        'engine','languages','mean_confidence','raw_text','extracted_fields','qr_payload',
        'reviewed_by','reviewed_at','voided_by','created_by','created_at','ai_usage_id','ai_detail']);    -- DOCS
      IF OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
        PERFORM app.fail('MRS_IMMUTABLE', 'transaction_id');
      END IF;
      IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
        PERFORM app.fail('MRS_IMMUTABLE', 'document_id');
      END IF;
    END IF;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status
       OR NEW.reviewed_fields IS DISTINCT FROM OLD.reviewed_fields
       OR NEW.line_items IS DISTINCT FROM OLD.line_items
       OR NEW.review_note IS DISTINCT FROM OLD.review_note
       OR NEW.doc_type IS DISTINCT FROM OLD.doc_type THEN
      NEW.reviewed_by := coalesce(auth.uid(), NEW.reviewed_by);
      NEW.reviewed_at := now();
    END IF;
    IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
      NEW.voided_by := auth.uid();
      NEW.voided_at := now();
    END IF;
  END IF;

  -- the attached original must be a live document of the same transaction
  IF NEW.document_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = NEW.document_id;
    IF v_doc.id IS NULL OR NEW.transaction_id IS NULL
       OR v_doc.transaction_id IS DISTINCT FROM NEW.transaction_id OR v_doc.voided_at IS NOT NULL THEN
      PERFORM app.fail('MRS_INVALID', 'document_id');
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- tg_audit (20261102000200 §4). DOCS: ai_detail (container / seal numbers, warnings) stays out of the trail like the rest
-- of the OCR content (body otherwise identical).
CREATE OR REPLACE FUNCTION app.tg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_org uuid;
BEGIN
  -- never copy secrets into the trail
  v_old := v_old - 'tracking_token_hash' - 'token_hash';
  v_new := v_new - 'tracking_token_hash' - 'token_hash';
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) k
    WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k <> 'updated_at';
    IF v_changed IS NULL THEN RETURN NULL; END IF;   -- no-op update
  END IF;
  -- OCR content stays in document_extractions (branch-scoped RLS), never in the trail
  IF TG_TABLE_NAME = 'document_extractions' THEN
    v_old := v_old - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note','ai_detail'];  -- DOCS
    v_new := v_new - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note','ai_detail'];  -- DOCS
  END IF;
  v_org := CASE WHEN TG_TABLE_NAME = 'organizations' THEN (v_row ->> 'id')::uuid
                ELSE nullif(v_row ->> 'org_id', '')::uuid END;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  -- tables keyed by user_id (platform_admins) have no id column
  VALUES (v_org, TG_TABLE_NAME, coalesce(v_row ->> 'id', v_row ->> 'user_id'), TG_OP, v_changed, v_old, v_new,
          auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 2. parties: aliases + the legacy shipping agents (deferred from step 1)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.party_aliases_ok(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NOT NULL AND cardinality(p) <= 20
     AND NOT EXISTS (SELECT 1 FROM unnest(p) a WHERE a IS NULL OR char_length(a) NOT BETWEEN 2 AND 160)
$$;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.parties DROP CONSTRAINT IF EXISTS parties_aliases_chk;
ALTER TABLE public.parties ADD CONSTRAINT parties_aliases_chk CHECK (app.party_aliases_ok(aliases));
COMMENT ON COLUMN public.parties.aliases IS 'Other names of the party as printed on documents (e.g. the legal / long name of a shipping line). Used by match_shipping_agent; never links anything by itself.';

-- the 15 agents of the legacy dictionary (APP.defaultShippingAgents / normalizeShippingAgentShort_, MarsaNorm.AGENTS):
-- the short name, an Arabic name, the aliases the legacy recognised. Public company names only.
CREATE OR REPLACE FUNCTION app.shipping_agents_template() RETURNS TABLE (sort int, name_en text, name_ar text, aliases text[])
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    (1, 'Hapag-Lloyd', 'هاباغ لويد', ARRAY['HAPAG LLOYD','HAPAG-LLOYD AG','هباج لويد']),
    (2, 'MSC', 'إم إس سي', ARRAY['MEDITERRANEAN SHIPPING COMPANY','MSC MEDITERRANEAN SHIPPING']),
    (3, 'ONE', 'أوشن نتورك إكسبريس', ARRAY['OCEAN NETWORK EXPRESS']),
    (4, 'Wan Hai', 'وان هاي', ARRAY['WAN HAI LINES']),
    (5, 'OOCL', 'أو أو سي إل', ARRAY['ORIENT OVERSEAS CONTAINER LINE']),
    (6, 'CMA CGM', 'سي إم إيه سي جي إم', ARRAY['CMA-CGM']),
    (7, 'Maersk', 'ميرسك', ARRAY['MAERSK LINE','A.P. MOLLER - MAERSK']),
    (8, 'PIL', 'بي آي إل', ARRAY['PACIFIC INTERNATIONAL LINES']),
    (9, 'Milaha', 'ملاحة', ARRAY['QATAR NAVIGATION']),
    (10, 'RCL', 'آر سي إل', ARRAY['REGIONAL CONTAINER LINES']),
    (11, 'T.S. Lines', 'تي إس لاينز', ARRAY['TS LINES','TSL']),
    (12, 'Yang Ming', 'يانغ مينغ', ARRAY['YANG MING MARINE TRANSPORT']),
    (13, 'Messina Line', 'ميسينا لاين', ARRAY['IGNAZIO MESSINA','MESSINA']),
    (14, 'ESL', 'إي إس إل', ARRAY['EMIRATES SHIPPING LINE']),
    (15, 'Kenzy', 'كنزي', ARRAY['KENZY INTERNATIONAL MARINE','KENZY MARINE'])
$$;

-- seed one org (idempotent): a template agent whose short / Arabic name or one of its aliases already names a party of
-- the org is never added again; when that party is a shipping agent its missing aliases (and the short name) are added.
-- → {added, updated, skipped}
CREATE OR REPLACE FUNCTION app.seed_shipping_agents(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  t record; v_p public.parties; v_keys text[]; v_add text[]; v_added int := 0; v_updated int := 0; v_skipped int := 0;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'organization');
  END IF;
  FOR t IN SELECT * FROM app.shipping_agents_template() ORDER BY 1 LOOP
    v_keys := ARRAY(SELECT DISTINCT app.legacy_search_key(x) FROM unnest(t.aliases || ARRAY[t.name_en, t.name_ar]) x
                     WHERE app.legacy_search_key(x) IS NOT NULL);
    SELECT * INTO v_p FROM public.parties p
     WHERE p.org_id = p_org
       AND (lower(p.name_ar) = lower(t.name_ar) OR app.legacy_search_key(p.name_ar) = ANY (v_keys)
            OR app.legacy_search_key(p.name_en) = ANY (v_keys)
            OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE app.legacy_search_key(a) = ANY (v_keys)))
     ORDER BY ('shipping_agent' = ANY (p.kinds)) DESC, p.created_at, p.id
     LIMIT 1;
    IF v_p.id IS NULL THEN
      INSERT INTO public.parties (org_id, kinds, name_ar, name_en, aliases, notes)
      VALUES (p_org, ARRAY['shipping_agent'], t.name_ar, t.name_en, t.aliases, 'وكيل ملاحي من القائمة الافتراضية للنظام السابق');
      v_added := v_added + 1;
    ELSIF 'shipping_agent' = ANY (v_p.kinds) THEN
      v_add := ARRAY(SELECT x FROM unnest(t.aliases || ARRAY[t.name_en]) x
                      WHERE app.legacy_search_key(x) IS DISTINCT FROM app.legacy_search_key(v_p.name_ar)
                        AND app.legacy_search_key(x) IS DISTINCT FROM app.legacy_search_key(v_p.name_en)
                        AND NOT EXISTS (SELECT 1 FROM unnest(v_p.aliases) a WHERE app.legacy_search_key(a) = app.legacy_search_key(x)));
      IF cardinality(v_add) > 0 AND cardinality(v_p.aliases) + cardinality(v_add) <= 20 THEN
        UPDATE public.parties p SET aliases = p.aliases || v_add, updated_at = now() WHERE p.id = v_p.id;
        v_updated := v_updated + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped);
END $$;

-- every existing org (a new org: public.seed_shipping_agents by its admin — no automatic seed, so fixtures stay empty)
DO $seed$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM public.organizations ORDER BY created_at, id LOOP
    PERFORM app.seed_shipping_agents(o.id);
  END LOOP;
END $seed$;

-- ---------------------------------------------------------------------
-- 3. tables
-- ---------------------------------------------------------------------
-- the shape of a batch draft (legacy normalizeDocumentDraft_, snake_case): NULL when valid, else the first problem
-- ('draft', 'draft.shipment.<key>', 'draft.invoice.items', …)
CREATE OR REPLACE FUNCTION app.doc_obj_check(p jsonb, p_path text, p_text text[], p_num text[], p_arr text[], p_neg text[])
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE e record; a jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) <> 'object' THEN RETURN p_path; END IF;
  FOR e IN SELECT key, value FROM jsonb_each(p) LOOP
    IF e.key = ANY (p_text) THEN
      IF jsonb_typeof(e.value) NOT IN ('string','null') OR char_length(e.value #>> '{}') > 2000 THEN RETURN p_path || '.' || e.key; END IF;
      IF e.key IN ('invoice_date','packing_list_date') AND jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') <> ''
         AND (e.value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN p_path || '.' || e.key;
      END IF;
    ELSIF e.key = ANY (p_num) THEN
      IF jsonb_typeof(e.value) = 'null' THEN CONTINUE; END IF;
      IF jsonb_typeof(e.value) <> 'number' OR abs((e.value #>> '{}')::numeric) > 99999999999
         OR ((e.value #>> '{}')::numeric < 0 AND NOT (e.key = ANY (p_neg))) THEN
        RETURN p_path || '.' || e.key;
      END IF;
    ELSIF e.key = ANY (p_arr) THEN
      IF jsonb_typeof(e.value) = 'null' THEN CONTINUE; END IF;
      IF jsonb_typeof(e.value) <> 'array' OR jsonb_array_length(e.value) > 300 THEN RETURN p_path || '.' || e.key; END IF;
      FOR a IN SELECT x FROM jsonb_array_elements(e.value) x LOOP
        IF jsonb_typeof(a) <> 'string' OR char_length(a #>> '{}') > 40 THEN RETURN p_path || '.' || e.key; END IF;
      END LOOP;
    ELSIF e.key NOT IN ('items','containers') THEN
      RETURN p_path || '.' || e.key;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.doc_batch_draft_check(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v text; r jsonb;
  s_text text[] := ARRAY['shipper','consignee','consignee_name','notify_party','booking_number','bl_number','vessel','voyage',
    'port_of_loading','port_of_discharge','place_of_receipt','place_of_delivery','freight_terms','goods_description',
    'package_type','shipping_line'];
  s_num text[] := ARRAY['packages_count','net_weight','gross_weight','measurement_cbm','temperature_c'];
  i_text text[] := ARRAY['invoice_number','invoice_date','seller','buyer','currency','country_of_origin','export_country',
    'incoterms','payment_terms','bl_number','vessel','voyage','port_of_loading','port_of_discharge'];
  p_text text[] := ARRAY['packing_list_number','packing_list_date','package_type','bl_number','vessel','voyage',
    'port_of_loading','port_of_discharge'];
  ii_text text[] := ARRAY['description','scientific_name','supplier_hs_code','unit','origin_country','notes','invoice_number'];
  ii_num text[] := ARRAY['quantity','unit_price','total','net_weight','gross_weight'];
  pi_text text[] := ARRAY['description','unit','container_number','seal_number','notes','packing_list_number'];
  pi_num text[] := ARRAY['packages','quantity','net_weight','gross_weight'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN 'draft'; END IF;
  IF octet_length(p::text) > 500000 THEN RETURN 'draft.size'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k = ANY (ARRAY['shipment','invoice','packing','declaration','source_notes']))) THEN
    RETURN 'draft.unknown_key';
  END IF;
  v := app.doc_obj_check(p -> 'shipment', 'draft.shipment', s_text, s_num, '{}', ARRAY['temperature_c']);
  IF v IS NOT NULL THEN RETURN v; END IF;
  v := app.doc_obj_check(p -> 'invoice', 'draft.invoice', i_text, ARRAY['total'], ARRAY['container_numbers','seal_numbers'], '{}');
  IF v IS NOT NULL THEN RETURN v; END IF;
  v := app.doc_obj_check(p -> 'packing', 'draft.packing', p_text, ARRAY['total_packages','total_net_weight','total_gross_weight'],
                         ARRAY['container_numbers','seal_numbers'], '{}');
  IF v IS NOT NULL THEN RETURN v; END IF;
  v := app.doc_obj_check(p -> 'declaration', 'draft.declaration', ARRAY['declaration_number'], '{}', '{}', '{}');
  IF v IS NOT NULL THEN RETURN v; END IF;
  IF jsonb_typeof(p #> '{declaration,items}') IS NOT NULL OR jsonb_typeof(p #> '{declaration,containers}') IS NOT NULL
     OR jsonb_typeof(p #> '{shipment,items}') IS NOT NULL OR jsonb_typeof(p #> '{invoice,containers}') IS NOT NULL
     OR jsonb_typeof(p #> '{packing,containers}') IS NOT NULL THEN
    RETURN 'draft.unknown_key';
  END IF;
  -- shipment.containers: ≤ 300 rows {container_number (ISO 6346 shape), seal_number, size_type, packages_count, net_weight, gross_weight}
  IF jsonb_typeof(p #> '{shipment,containers}') NOT IN ('array','null') OR jsonb_array_length(coalesce(nullif(p #> '{shipment,containers}', 'null'), '[]')) > 300 THEN
    RETURN 'draft.shipment.containers';
  END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p #> '{shipment,containers}', 'null'), '[]')) x LOOP
    v := app.doc_obj_check(r, 'draft.shipment.containers', ARRAY['container_number','seal_number','size_type'],
                           ARRAY['packages_count','net_weight','gross_weight'], '{}', '{}');
    IF v IS NOT NULL OR jsonb_typeof(r) <> 'object' OR coalesce(r ->> 'container_number', '') !~ '^[A-Z]{4}[0-9]{7}$'
       OR char_length(r ->> 'seal_number') > 30 OR char_length(r ->> 'size_type') > 10 THEN
      RETURN 'draft.shipment.containers';
    END IF;
  END LOOP;
  -- items: ≤ 500 rows each
  FOR v IN SELECT unnest(ARRAY['invoice','packing']) LOOP
    IF jsonb_typeof(p #> ARRAY[v,'items']) NOT IN ('array','null') OR jsonb_array_length(coalesce(nullif(p #> ARRAY[v,'items'], 'null'), '[]')) > 500 THEN
      RETURN 'draft.' || v || '.items';
    END IF;
    FOR r IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p #> ARRAY[v,'items'], 'null'), '[]')) x LOOP
      IF jsonb_typeof(r) <> 'object' OR app.doc_obj_check(r, 'x', CASE WHEN v = 'invoice' THEN ii_text ELSE pi_text END,
                                                         CASE WHEN v = 'invoice' THEN ii_num ELSE pi_num END, '{}', '{}') IS NOT NULL
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE k IN ('items','containers')) THEN
        RETURN 'draft.' || v || '.items';
      END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p -> 'source_notes') NOT IN ('array','null') OR jsonb_array_length(coalesce(nullif(p -> 'source_notes', 'null'), '[]')) > 50
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p -> 'source_notes', 'null'), '[]')) n
                 WHERE jsonb_typeof(n) <> 'string' OR char_length(n #>> '{}') > 500) THEN
    RETURN 'draft.source_notes';
  END IF;
  RETURN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.doc_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL,
  kind                text NOT NULL DEFAULT 'shipment' CHECK (kind IN ('shipment')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','discarded','archived')),
  transaction_id      uuid,
  client_id           uuid,
  draft               jsonb NOT NULL DEFAULT '{}'::jsonb,
  comparison          jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_match        jsonb,
  bl_number           text CHECK (char_length(bl_number) <= 80),
  importer_name       text CHECK (char_length(importer_name) <= 160),
  container_count     int NOT NULL DEFAULT 0 CHECK (container_count BETWEEN 0 AND 300),
  version             int NOT NULL DEFAULT 1 CHECK (version >= 1),
  note                text CHECK (char_length(note) <= 1000),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  approved_by         uuid,
  approved_at         timestamptz,
  approve_result      jsonb,
  created_transaction boolean NOT NULL DEFAULT false,
  closed_by           uuid,
  closed_at           timestamptz,
  close_reason        text CHECK (char_length(close_reason) <= 500),
  CONSTRAINT doc_batches_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT doc_batches_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT doc_batches_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT doc_batches_draft_chk CHECK (app.doc_batch_draft_check(draft) IS NULL),
  CONSTRAINT doc_batches_comparison_chk CHECK (jsonb_typeof(comparison) = 'object' AND octet_length(comparison::text) <= 200000),
  CONSTRAINT doc_batches_client_match_chk CHECK (client_match IS NULL OR (jsonb_typeof(client_match) = 'object'
                                                 AND octet_length(client_match::text) <= 20000)),
  CONSTRAINT doc_batches_result_chk CHECK (approve_result IS NULL OR jsonb_typeof(approve_result) = 'object'),
  CONSTRAINT doc_batches_approved_chk CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL)
                                             AND (status <> 'approved' OR transaction_id IS NOT NULL)),
  CONSTRAINT doc_batches_closed_chk CHECK ((status IN ('discarded','archived')) = (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.doc_batches IS 'Legacy port step 3: one shipment''s set of documents (B/L, invoice(s), packing list(s), optional customs declaration) read by AI / OCR, merged into ONE reviewable draft (legacy «مسودات المستندات»). Every value is a draft until a staff member approves it (approve_doc_batch); nothing is approved automatically. Written only through the RPCs; no DELETE (discard / archive). Branch-scoped.';
CREATE INDEX IF NOT EXISTS doc_batches_org_status_idx ON public.doc_batches (org_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS doc_batches_tx_idx ON public.doc_batches (transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.doc_batch_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  batch_id       uuid NOT NULL,
  slot           text NOT NULL CHECK (slot IN ('bill_of_lading','commercial_invoice','packing_list','customs_declaration')),
  seq            int NOT NULL CHECK (seq BETWEEN 1 AND 10),
  extraction_id  uuid NOT NULL,
  detected_type  text NOT NULL CHECK (char_length(detected_type) <= 40),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  detached_at    timestamptz,
  detached_by    uuid,
  detach_reason  text CHECK (char_length(detach_reason) <= 500),
  CONSTRAINT doc_batch_documents_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.doc_batches(id, org_id),
  CONSTRAINT doc_batch_documents_ext_fk FOREIGN KEY (extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  CONSTRAINT doc_batch_documents_detach_chk CHECK ((detached_at IS NULL) = (detached_by IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.doc_batch_documents IS 'The slots of a doc batch: which saved reading (document_extractions) sits in which slot. The extraction''s detected type must match the slot (wrong-slot guard). Detach = void (detached_at); no DELETE.';
CREATE UNIQUE INDEX IF NOT EXISTS doc_batch_documents_live_uidx ON public.doc_batch_documents (batch_id, extraction_id) WHERE detached_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS doc_batch_documents_slot_uidx ON public.doc_batch_documents (batch_id, slot, seq) WHERE detached_at IS NULL;
CREATE INDEX IF NOT EXISTS doc_batch_documents_ext_idx ON public.doc_batch_documents (extraction_id);

CREATE TABLE IF NOT EXISTS public.transaction_shipment_data (
  transaction_id          uuid PRIMARY KEY,
  org_id                  uuid NOT NULL,
  batch_id                uuid NOT NULL,
  -- shipment (B/L)
  shipper                 text CHECK (char_length(shipper) <= 2000),
  consignee               text CHECK (char_length(consignee) <= 2000),
  consignee_name          text CHECK (char_length(consignee_name) <= 160),
  notify_party            text CHECK (char_length(notify_party) <= 2000),
  booking_number          text CHECK (char_length(booking_number) <= 120),
  bl_number               text CHECK (char_length(bl_number) <= 80),
  vessel                  text CHECK (char_length(vessel) <= 160),
  voyage                  text CHECK (char_length(voyage) <= 80),
  port_of_loading         text CHECK (char_length(port_of_loading) <= 160),
  port_of_discharge       text CHECK (char_length(port_of_discharge) <= 160),
  place_of_receipt        text CHECK (char_length(place_of_receipt) <= 160),
  place_of_delivery       text CHECK (char_length(place_of_delivery) <= 160),
  goods_description       text CHECK (char_length(goods_description) <= 2000),
  packages_count          numeric(14,3) CHECK (packages_count >= 0),
  package_type            text CHECK (char_length(package_type) <= 80),
  net_weight_kg           numeric(16,3) CHECK (net_weight_kg >= 0),
  gross_weight_kg         numeric(16,3) CHECK (gross_weight_kg >= 0),
  measurement_cbm         numeric(14,3) CHECK (measurement_cbm >= 0),
  temperature_c           numeric(7,2),
  freight_terms           text CHECK (char_length(freight_terms) <= 120),
  shipping_line           text CHECK (char_length(shipping_line) <= 160),
  -- invoice
  invoice_number          text CHECK (char_length(invoice_number) <= 120),
  invoice_date            date,
  seller                  text CHECK (char_length(seller) <= 2000),
  buyer                   text CHECK (char_length(buyer) <= 2000),
  currency                text CHECK (char_length(currency) <= 10),
  country_of_origin       text CHECK (char_length(country_of_origin) <= 120),
  export_country          text CHECK (char_length(export_country) <= 120),
  total_value             numeric(18,3) CHECK (total_value >= 0),
  incoterms               text CHECK (char_length(incoterms) <= 120),
  payment_terms           text CHECK (char_length(payment_terms) <= 120),
  -- packing list
  packing_list_number     text CHECK (char_length(packing_list_number) <= 120),
  packing_list_date       date,
  packing_total_packages  numeric(14,3) CHECK (packing_total_packages >= 0),
  packing_package_type    text CHECK (char_length(packing_package_type) <= 80),
  packing_net_weight_kg   numeric(16,3) CHECK (packing_net_weight_kg >= 0),
  packing_gross_weight_kg numeric(16,3) CHECK (packing_gross_weight_kg >= 0),
  -- review
  containers              jsonb NOT NULL DEFAULT '[]'::jsonb,
  matches                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts               jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_fields          jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_notes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft                   jsonb CHECK (draft IS NULL OR (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 2000000)),
  approved_by             uuid NOT NULL,
  approved_at             timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_shipment_data_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT transaction_shipment_data_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.doc_batches(id, org_id),
  CONSTRAINT transaction_shipment_data_json_chk CHECK (jsonb_typeof(containers) = 'array' AND jsonb_typeof(matches) = 'array'
    AND jsonb_typeof(conflicts) = 'array' AND jsonb_typeof(missing_fields) = 'array' AND jsonb_typeof(source_notes) = 'array'
    AND octet_length(containers::text) + octet_length(matches::text) + octet_length(conflicts::text) <= 300000),
  UNIQUE (transaction_id, org_id)
);
COMMENT ON TABLE public.transaction_shipment_data IS 'Legacy «بيانات فسح» record: the approved shipment / invoice / packing header of a transaction (+ the containers snapshot, matches, conflicts, missing fields). Written only by approve_doc_batch (a later approval replaces it; the trail and the batch keep the history). Staff of the transaction''s branch read it; clients do not.';
-- REVIEW: the combined approved draft (every approval of the transaction laid over the previous one), the base of the next
ALTER TABLE public.transaction_shipment_data ADD COLUMN IF NOT EXISTS draft jsonb
  CHECK (draft IS NULL OR (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 2000000));
COMMENT ON COLUMN public.transaction_shipment_data.draft IS 'The combined approved draft of the transaction (shipment / invoice / packing / declaration sections): a later batch is laid over it (non-empty values win, containers by number, an item list only when the batch has one), so a late document never wipes the data approved before.';

CREATE TABLE IF NOT EXISTS public.shipment_invoice_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  transaction_id   uuid NOT NULL,
  batch_id         uuid NOT NULL,
  line_no          int NOT NULL CHECK (line_no BETWEEN 1 AND 5000),
  invoice_number   text CHECK (char_length(invoice_number) <= 120),
  description      text CHECK (char_length(description) <= 2000),
  scientific_name  text CHECK (char_length(scientific_name) <= 300),
  supplier_hs_code text CHECK (char_length(supplier_hs_code) <= 40),
  quantity         numeric(18,3) CHECK (quantity >= 0),
  unit             text CHECK (char_length(unit) <= 40),
  unit_price       numeric(18,4) CHECK (unit_price >= 0),
  total            numeric(18,3) CHECK (total >= 0),
  origin_country   text CHECK (char_length(origin_country) <= 120),
  net_weight_kg    numeric(16,3) CHECK (net_weight_kg >= 0),
  gross_weight_kg  numeric(16,3) CHECK (gross_weight_kg >= 0),
  notes            text CHECK (char_length(notes) <= 500),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  voided_by        uuid,
  void_reason      text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT shipment_invoice_items_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT shipment_invoice_items_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.doc_batches(id, org_id),
  CONSTRAINT shipment_invoice_items_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.shipment_invoice_items IS 'Legacy «أصناف الفاتورة»: the approved invoice lines of a transaction. supplier_hs_code is the supplier''s code as printed (reference only, not a Saudi tariff decision); the scientific name is kept apart from the description. Written only by approve_doc_batch; a new approval voids the previous lines (void-only, no DELETE).';
CREATE INDEX IF NOT EXISTS shipment_invoice_items_tx_idx ON public.shipment_invoice_items (transaction_id) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS public.shipment_packing_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  transaction_id      uuid NOT NULL,
  batch_id            uuid NOT NULL,
  line_no             int NOT NULL CHECK (line_no BETWEEN 1 AND 5000),
  packing_list_number text CHECK (char_length(packing_list_number) <= 120),
  description         text CHECK (char_length(description) <= 2000),
  packages            numeric(14,3) CHECK (packages >= 0),
  quantity            numeric(18,3) CHECK (quantity >= 0),
  unit                text CHECK (char_length(unit) <= 40),
  net_weight_kg       numeric(16,3) CHECK (net_weight_kg >= 0),
  gross_weight_kg     numeric(16,3) CHECK (gross_weight_kg >= 0),
  container_no        text CHECK (char_length(container_no) <= 20),
  seal_no             text CHECK (char_length(seal_no) <= 30),
  notes               text CHECK (char_length(notes) <= 500),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  voided_at           timestamptz,
  voided_by           uuid,
  void_reason         text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT shipment_packing_items_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT shipment_packing_items_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.doc_batches(id, org_id),
  CONSTRAINT shipment_packing_items_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.shipment_packing_items IS 'Legacy «تفاصيل التعبئة»: the approved packing-list lines of a transaction (packages, quantity, weights, container, seal). Written only by approve_doc_batch; a new approval voids the previous lines (void-only, no DELETE).';
CREATE INDEX IF NOT EXISTS shipment_packing_items_tx_idx ON public.shipment_packing_items (transaction_id) WHERE voided_at IS NULL;

-- guards: no DELETE anywhere; items: only the void columns change, once; a detached slot is frozen
CREATE OR REPLACE FUNCTION app.tg_legacy_docs_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM app.fail('MRS_APPEND_ONLY', TG_TABLE_NAME);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION app.tg_legacy_docs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME IN ('shipment_invoice_items','shipment_packing_items') THEN
    IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'voided_at'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason'],
                                to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason'],
                                ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason'])));
  ELSIF TG_TABLE_NAME = 'doc_batch_documents' THEN
    IF OLD.detached_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'detached_at'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','batch_id','slot','seq','extraction_id',
      'detected_type','created_by','created_at']);
  ELSIF TG_TABLE_NAME = 'doc_batches' THEN
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','kind','created_by','created_at']);
    IF OLD.status IN ('approved','archived') AND NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM app.fail('MRS_DOC_BATCH_STATE', OLD.status);
    END IF;
    IF OLD.status = 'approved' THEN
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['draft','comparison','transaction_id','approved_by',
        'approved_at','approve_result','client_id']);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- the trail without the document content (audit_select is org-wide; the batches / shipment data are branch-scoped):
-- TG_ARGV = keys removed from old_data / new_data; changed_fields still names every change
CREATE OR REPLACE FUNCTION app.tg_legacy_docs_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_strip text[] := coalesce(TG_ARGV::text[], '{}');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed FROM jsonb_object_keys(v_new) k
     WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k <> 'updated_at';
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;
  v_old := v_old - v_strip;
  v_new := v_new - v_strip;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (nullif(v_row ->> 'org_id', '')::uuid, TG_TABLE_NAME, coalesce(v_row ->> 'id', v_row ->> 'transaction_id'), TG_OP,
          v_changed, v_old, v_new, auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_guard ON public.doc_batches;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.doc_batches FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.doc_batch_documents;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.doc_batch_documents FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.shipment_invoice_items;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.shipment_invoice_items FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.shipment_packing_items;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.shipment_packing_items FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_guard();
DROP TRIGGER IF EXISTS trg_no_delete ON public.doc_batches;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.doc_batches FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.doc_batch_documents;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.doc_batch_documents FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.transaction_shipment_data;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.transaction_shipment_data FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.shipment_invoice_items;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.shipment_invoice_items FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.shipment_packing_items;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.shipment_packing_items FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_audit ON public.doc_batches;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.doc_batches FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('draft', 'comparison', 'client_match', 'note', 'close_reason', 'approve_result', 'bl_number', 'importer_name');
DROP TRIGGER IF EXISTS trg_audit ON public.doc_batch_documents;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.doc_batch_documents FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('detach_reason');
DROP TRIGGER IF EXISTS trg_audit ON public.transaction_shipment_data;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.transaction_shipment_data FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('shipper', 'consignee', 'consignee_name', 'notify_party', 'booking_number', 'bl_number',
    'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'place_of_receipt', 'place_of_delivery', 'goods_description',
    'packages_count', 'package_type', 'net_weight_kg', 'gross_weight_kg', 'measurement_cbm', 'temperature_c', 'freight_terms',
    'shipping_line', 'invoice_number', 'invoice_date', 'seller', 'buyer', 'currency', 'country_of_origin', 'export_country',
    'total_value', 'incoterms', 'payment_terms', 'packing_list_number', 'packing_list_date', 'packing_total_packages',
    'packing_package_type', 'packing_net_weight_kg', 'packing_gross_weight_kg', 'containers', 'matches', 'conflicts',
    'missing_fields', 'source_notes', 'draft');
DROP TRIGGER IF EXISTS trg_audit ON public.shipment_invoice_items;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.shipment_invoice_items FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('invoice_number', 'description', 'scientific_name', 'supplier_hs_code', 'quantity', 'unit',
    'unit_price', 'total', 'origin_country', 'net_weight_kg', 'gross_weight_kg', 'notes', 'void_reason');
DROP TRIGGER IF EXISTS trg_audit ON public.shipment_packing_items;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.shipment_packing_items FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('packing_list_number', 'description', 'packages', 'quantity', 'unit', 'net_weight_kg',
    'gross_weight_kg', 'container_no', 'seal_no', 'notes', 'void_reason');

-- ---------------------------------------------------------------------
-- 4. helpers
-- ---------------------------------------------------------------------
-- legacy extractCustomerIdentityName_ (CustomerMatch.js) = extract.js identityName: the consignee NAME out of an
-- address block (labels, address / contact part, CR / VAT / long numbers, NOTIFY lines dropped; ≤ 2 lines, ≤ 16 words)
CREATE OR REPLACE FUNCTION app.consignee_identity_name(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v text; v_pos int; v_lines text[]; v_kept text[] := '{}'; v_part text; v_res text; i int;
  c_stop text := '(\y(ADD(RESS)?|NATIONAL\s+ADDRESS|P\.?\s*O\.?\s*BOX|POSTAL|ZIP|BUILDING|BLDG|STREET|ST\.?|ROAD|RD\.?|DISTRICT|'
    || 'DIST\.?|CITY|JEDDAH|RIYADH|DAMMAM|MAKKAH|MECCA|SAUDI\s+ARABIA|KINGDOM\s+OF\s+SAUDI\s+ARABIA|KSA|C\.?R\.?\s*(NO|NUMBER)?|'
    || 'COMMERCIAL\s+REGISTRATION|VAT|TAX\s*(NO|NUMBER)?|EMAIL|E-?MAIL|PHONE|TEL|MOBILE|FAX|CONTACT)\y|\+966|@[A-Z0-9._%+-]+\.[A-Z]{2,})';
BEGIN
  IF p IS NULL OR btrim(regexp_replace(app.legacy_spaces(p), '\s+', ' ', 'g')) = '' THEN RETURN NULL; END IF;
  v := regexp_replace(replace(replace(app.legacy_spaces(p), E'\r', E'\n'), E'\t', ' '), '[|]+', E'\n', 'g');
  v := regexp_replace(v, '^\s*(CONSIGNEE|IMPORTER|BUYER|SHIP\s*TO|SOLD\s*TO|CUSTOMER)\s*[:\-]\s*', '', 'i');
  v_pos := regexp_instr(v, '\s+\d{3,6}\s+[A-Z؀-ۿ]', 1, 1, 0, 'i');
  IF v_pos > 0 THEN v := left(v, v_pos - 1); END IF;
  v_pos := regexp_instr(v, c_stop, 1, 1, 0, 'i');
  IF v_pos > 0 THEN v := left(v, v_pos - 1); END IF;
  v_lines := ARRAY(SELECT x FROM (SELECT btrim(regexp_replace(btrim(regexp_replace(l, '[ \t]+', ' ', 'g')), '^[,;:\-]+|[,;:\-]+$', '', 'g')) x, o
                                    FROM unnest(regexp_split_to_array(v, E'\n+')) WITH ORDINALITY AS u(l, o)) s
                   WHERE x <> '' ORDER BY o);
  FOR i IN 1 .. coalesce(array_length(v_lines, 1), 0) LOOP
    EXIT WHEN cardinality(v_kept) >= 2;
    v_part := v_lines[i];
    EXIT WHEN v_part ~* '^(NOTIFY|ATTN|REFERENCE|REF\.?|ACCOUNT)\y';
    v_part := btrim(regexp_replace(v_part, '\y(VAT|CR|C\.?R\.?)\s*(NO|NUMBER)?\s*[:#-]?\s*\d+.*$', '', 'i'));
    v_part := btrim(regexp_replace(v_part, '\y\d{6,}\y.*$', ''));
    IF v_part <> '' THEN v_kept := v_kept || v_part; END IF;
  END LOOP;
  v_res := btrim(regexp_replace(array_to_string(v_kept, ' '), '\s+', ' ', 'g'));
  IF v_res = '' THEN v_res := btrim(regexp_replace(coalesce(v_lines[1], app.legacy_spaces(p)), '\s+', ' ', 'g')); END IF;
  v_res := regexp_replace(v_res, '\s+', ' ', 'g');
  v_res := regexp_replace(v_res, '\y(ADD|ADDRESS)\s*[:\-]?.*$', '', 'i');
  v_res := btrim(regexp_replace(v_res, '[,;:\-]+$', ''));
  RETURN nullif(left(array_to_string((regexp_split_to_array(v_res, ' '))[1:16], ' '), 160), '');
END $$;

-- legacy normalizeCustomerLatinName_: upper case, & → AND, punctuation → space, company-form words dropped
CREATE OR REPLACE FUNCTION app.client_latin_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(regexp_replace(regexp_replace(regexp_replace(replace(upper(app.legacy_spaces(coalesce(p, ''))), '&', ' AND '),
    '[^A-Z0-9؀-ۿ]+', ' ', 'g'),
    '\y(COMPANY|CO|LTD|LIMITED|LLC|ESTABLISHMENT|EST|TRADING|TRADE|CORPORATION|CORP|INC|CONTRACTING|CONTRACTOR|CONTRACTORS|'
    || 'ENTERPRISE|ENTERPRISES|COMMERCIAL|GENERAL|PROJECTS|PROJECT|SERVICES|SERVICE|INDUSTRIES|INDUSTRIAL|FACTORY|BRANCH)\y', ' ', 'g'),
    '\s+', ' ', 'g')), '')
$$;

-- REVIEW: the legacy local client scoring (CustomerMatch.js scoreCustomerCandidate_ and its helpers), so an English consignee
-- finds an Arabic-only client: the client's Arabic name transliterated to Latin (arabicToLatinRough_), a vowel-less
-- phonetic key (customerPhoneticKey_), Levenshtein similarity (customerStringSimilarity_), token alignment with coverage
-- (customerTokenAlignment_) and the +10 full-coverage bonus. The AI interpret / judge step is not ported.
CREATE OR REPLACE FUNCTION app.cm_lev(a text, b text) RETURNS int
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE x text[] := string_to_array(coalesce(a, ''), NULL); y text[] := string_to_array(coalesce(b, ''), NULL);
  m int := cardinality(string_to_array(coalesce(a, ''), NULL)); n int := cardinality(string_to_array(coalesce(b, ''), NULL));
  prev int[]; cur int[]; i int; j int;
BEGIN
  IF m = 0 THEN RETURN n; END IF;
  IF n = 0 THEN RETURN m; END IF;
  prev := ARRAY(SELECT g FROM generate_series(0, n) g);
  FOR i IN 1 .. m LOOP
    cur := ARRAY[i];
    FOR j IN 1 .. n LOOP
      cur := cur || least(cur[j] + 1, prev[j + 1] + 1, prev[j] + CASE WHEN x[i] = y[j] THEN 0 ELSE 1 END);
    END LOOP;
    prev := cur;
  END LOOP;
  RETURN prev[n + 1];
END $$;
-- customerStringSimilarity_: 1 − distance / longer length (0 when either side is empty)
CREATE OR REPLACE FUNCTION app.cm_str_sim(a text, b text) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN coalesce(btrim(a), '') = '' OR coalesce(btrim(b), '') = '' THEN 0::numeric
              WHEN btrim(a) = btrim(b) THEN 1::numeric
              ELSE 1 - app.cm_lev(btrim(a), btrim(b))::numeric / greatest(char_length(btrim(a)), char_length(btrim(b))) END
$$;
-- customerPhoneticKey_: upper case, letters / digits only, vowels and Y dropped
CREATE OR REPLACE FUNCTION app.cm_phonetic(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT regexp_replace(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '[AEIOUY]', '', 'g')
$$;
-- customerTokenSimilarity_: the better of the direct and the phonetic similarity
CREATE OR REPLACE FUNCTION app.cm_token_sim(a text, b text) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN coalesce(btrim(a), '') = '' OR coalesce(btrim(b), '') = '' THEN 0::numeric
              WHEN upper(btrim(a)) = upper(btrim(b)) THEN 1::numeric
              ELSE greatest(app.cm_str_sim(upper(btrim(a)), upper(btrim(b))), app.cm_str_sim(app.cm_phonetic(a), app.cm_phonetic(b))) END
$$;
-- customerTokenAlignment_ → {score, source_coverage, candidate_coverage}
CREATE OR REPLACE FUNCTION app.cm_align(p_src text[], p_cand text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  WITH m AS (SELECT s, c, app.cm_token_sim(s, c) v FROM unnest(p_src) WITH ORDINALITY AS a(s, i), unnest(p_cand) WITH ORDINALITY AS b(c, j)),
       sbl AS (SELECT (SELECT max(v) FROM m WHERE m.s = x.s) v FROM unnest(p_src) AS x(s)),
       cbl AS (SELECT (SELECT max(v) FROM m WHERE m.c = y.c) v FROM unnest(p_cand) AS y(c))
  SELECT jsonb_build_object(
    'score', coalesce((SELECT avg(coalesce(v, 0)) FROM sbl), 0) * 0.6 + coalesce((SELECT avg(coalesce(v, 0)) FROM cbl), 0) * 0.4,
    'source_coverage', coalesce((SELECT count(*) FILTER (WHERE v >= 0.72)::numeric / greatest(count(*), 1) FROM sbl), 0),
    'candidate_coverage', coalesce((SELECT count(*) FILTER (WHERE v >= 0.72)::numeric / greatest(count(*), 1) FROM cbl), 0))
$$;
-- customerArabicCoreTokens_: normalizeCustomerName_ + the generic company words dropped (tokens of ≥ 2 characters)
CREATE OR REPLACE FUNCTION app.cm_ar_tokens(p text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(t ORDER BY o), '{}') FROM unnest(regexp_split_to_array(btrim(regexp_replace(regexp_replace(
           translate(lower(app.legacy_spaces(coalesce(p, ''))), 'أإآةى', 'اااهي'), '[ً-ٟ]', '', 'g'), '[^؀-ۿa-z0-9]+', ' ', 'g')), ' '))
           WITH ORDINALITY AS u(t, o)
   WHERE char_length(t) > 1 AND NOT t = ANY (ARRAY['شركة','شركه','مؤسسة','مؤسسه','التجارة','التجاره','تجارة','تجاره','التجارية','التجاريه',
     'للتجارة','للتجاره','المقاولات','المقاولاات','للمقاولات','للمقاولاات','مقاولات','المحدودة','المحدوده','محدودة','محدوده',
     'شخص','واحد','فرع','مصنع','مصانع','العامة','العامه','للخدمات','خدمات','الصناعية','الصناعيه'])
$$;
-- arabicToLatinRough_: one Arabic token → rough Latin letters
CREATE OR REPLACE FUNCTION app.cm_ar_latin(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT regexp_replace(translate(replace(replace(replace(replace(replace(replace(upper(coalesce(p, '')),
           'ث', 'TH'), 'خ', 'KH'), 'ذ', 'DH'), 'ش', 'SH'), 'غ', 'GH'), 'ء', ''),
           'اأإآبتجحدرزسصضطظعفقكلمنهةوؤيىئ', 'AAAABTJHDRZSSDTZAFQKLMNHAWWYAY'), '[^A-Z0-9]', '', 'g')
$$;
-- scoreCustomerCandidate_ (without the AI interpretation) → {confidence 0–100, source_coverage}
CREATE OR REPLACE FUNCTION app.cm_score(p_src text, p_en text, p_ar text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_src text[] := ARRAY(SELECT t FROM unnest(string_to_array(coalesce(app.client_latin_key(p_src), ''), ' ')) t WHERE char_length(t) > 1);
  v_tr text[] := ARRAY(SELECT x FROM (SELECT app.cm_ar_latin(t) x FROM unnest(app.cm_ar_tokens(p_ar)) t) z WHERE x <> '');
  v_cand text[]; al jsonb; v_tok numeric := 0; v_cmp numeric := 0; v_scov numeric := 0; v_ccov numeric := 0;
  v_score numeric; v_sc text; v_cc text; i int;
BEGIN
  IF cardinality(v_src) = 0 THEN RETURN jsonb_build_object('confidence', 0, 'source_coverage', 0); END IF;
  v_sc := array_to_string(v_src, '');
  FOR i IN 1 .. 2 LOOP
    v_cand := CASE WHEN i = 1 THEN ARRAY(SELECT t FROM unnest(string_to_array(coalesce(app.client_latin_key(p_en), ''), ' ')) t WHERE char_length(t) > 1)
                   ELSE v_tr END;
    CONTINUE WHEN cardinality(v_cand) = 0;
    al := app.cm_align(v_src, v_cand);
    IF (al ->> 'score')::numeric > v_tok THEN
      v_tok := (al ->> 'score')::numeric; v_scov := (al ->> 'source_coverage')::numeric; v_ccov := (al ->> 'candidate_coverage')::numeric;
    END IF;
    v_cc := array_to_string(v_cand, '');
    v_cmp := greatest(v_cmp, app.cm_str_sim(v_sc, v_cc), app.cm_str_sim(app.cm_phonetic(v_sc), app.cm_phonetic(v_cc)));
  END LOOP;
  v_score := (v_tok * 0.72 + v_cmp * 0.28) * 100;
  IF least(cardinality(v_src), cardinality(v_tr)) >= 2 AND v_scov >= 0.98 AND v_ccov >= 0.98 AND v_tok >= 0.76 THEN v_score := v_score + 10; END IF;
  RETURN jsonb_build_object('confidence', greatest(0, least(100, round(v_score)))::int, 'source_coverage', round(v_scov, 3));
END $$;

-- a draft value as comparable text / number
CREATE OR REPLACE FUNCTION app.doc_val(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) = 'null' THEN NULL
              WHEN jsonb_typeof(p) = 'number' THEN CASE WHEN (p #>> '{}')::numeric = 0 THEN NULL
                                                         ELSE trim_scale(round((p #>> '{}')::numeric, 3))::text END
              ELSE nullif(btrim(p #>> '{}'), '') END
$$;
CREATE OR REPLACE FUNCTION app.doc_num(p jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'number' THEN (p #>> '{}')::numeric
              WHEN jsonb_typeof(p) = 'string' AND replace(btrim(p #>> '{}'), ',', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN replace(btrim(p #>> '{}'), ',', '')::numeric END
$$;

-- REVIEW: legacy normalizeValidBillNo_ — a B/L number printed as a placeholder (0…0, N/A, NA, NONE, NULL, غير متوفر) is no
-- B/L number: NULL (applied to the B/L, invoice and packing-list numbers of every reading and of the approved draft)
CREATE OR REPLACE FUNCTION app.doc_bl_no(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN app.norm_code(p) IS NULL OR app.norm_code(p) ~* '^(0+|N/?A|NONE|NULL|غيرمتوفر)$' THEN NULL ELSE app.norm_code(p) END
$$;

-- legacy compareField_: ≥ 2 sources with a value → one match or one conflict row. p_vals = {bl?, invoice?, packing?}
-- (text values compared through app.legacy_search_key, numbers rounded to 3 decimals, sets: one ⊆ the other)
CREATE OR REPLACE FUNCTION app.doc_cmp_row(p_field text, p_vals jsonb, p_kind text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE e record; v_n int := 0; v_keys text[] := '{}'; v_sets jsonb[] := '{}'; v_k text; v_same boolean := true; a jsonb; b jsonb; i int; j int;
  v_clean jsonb := '{}'::jsonb;
BEGIN
  FOR e IN SELECT key, value FROM jsonb_each(coalesce(p_vals, '{}'::jsonb)) ORDER BY array_position(ARRAY['bl','invoice','packing'], key) LOOP
    IF p_kind = 'set' THEN
      IF jsonb_typeof(e.value) <> 'array' OR jsonb_array_length(e.value) = 0 THEN CONTINUE; END IF;
      v_sets := v_sets || (SELECT jsonb_agg(DISTINCT app.legacy_search_key(x #>> '{}')) FROM jsonb_array_elements(e.value) x
                            WHERE app.legacy_search_key(x #>> '{}') IS NOT NULL);
      IF v_sets[cardinality(v_sets)] IS NULL THEN v_sets := v_sets[1:cardinality(v_sets) - 1]; CONTINUE; END IF;
    ELSE
      v_k := CASE WHEN p_kind = 'num' THEN app.doc_val(to_jsonb(round(app.doc_num(e.value), 3)))
                  ELSE app.legacy_search_key(app.doc_val(e.value)) END;
      IF v_k IS NULL THEN CONTINUE; END IF;
      v_keys := v_keys || v_k;
    END IF;
    v_clean := v_clean || jsonb_build_object(e.key, e.value);
    v_n := v_n + 1;
  END LOOP;
  IF v_n < 2 THEN RETURN NULL; END IF;
  IF p_kind = 'set' THEN
    FOR i IN 1 .. cardinality(v_sets) LOOP
      FOR j IN i + 1 .. cardinality(v_sets) LOOP
        a := v_sets[i]; b := v_sets[j];
        IF NOT (a <@ b OR b <@ a) THEN v_same := false; END IF;
      END LOOP;
    END LOOP;
  ELSE
    v_same := (SELECT count(DISTINCT k) FROM unnest(v_keys) k) = 1;
  END IF;
  RETURN jsonb_build_object('field', p_field, 'status', CASE WHEN v_same THEN 'match' ELSE 'conflict' END, 'values', v_clean);
END $$;

-- legacy buildDocumentComparison_ over a draft → {matches: [...], conflicts: [...], missing_fields: [codes]}
-- + the seal / container numbers as sets (every container of the B/L, the invoice / packing list numbers)
CREATE OR REPLACE FUNCTION app.doc_batch_compare(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  s jsonb := coalesce(nullif(p -> 'shipment', 'null'), '{}'::jsonb);
  iv jsonb := coalesce(nullif(p -> 'invoice', 'null'), '{}'::jsonb);
  pk jsonb := coalesce(nullif(p -> 'packing', 'null'), '{}'::jsonb);
  v_ctr jsonb := coalesce(nullif(s -> 'containers', 'null'), '[]'::jsonb);
  v_ii jsonb := coalesce(nullif(iv -> 'items', 'null'), '[]'::jsonb);
  v_pi jsonb := coalesce(nullif(pk -> 'items', 'null'), '[]'::jsonb);
  v_rows jsonb := '[]'::jsonb; r jsonb; v_missing text[] := '{}';
  v_inv_net numeric; v_inv_pkg numeric;
BEGIN
  SELECT nullif(sum(coalesce(app.doc_num(x -> 'net_weight'), 0)), 0) INTO v_inv_net FROM jsonb_array_elements(v_ii) x;
  SELECT nullif(sum(CASE WHEN lower(coalesce(x ->> 'unit', '')) ~ '(carton|ctn|كرتون)' THEN coalesce(app.doc_num(x -> 'quantity'), 0) ELSE 0 END), 0)
    INTO v_inv_pkg FROM jsonb_array_elements(v_ii) x;
  FOR r IN SELECT x FROM unnest(ARRAY[
      app.doc_cmp_row('bl_number', jsonb_strip_nulls(jsonb_build_object('bl', to_jsonb(app.doc_bl_no(app.doc_val(s -> 'bl_number'))),
          'invoice', to_jsonb(app.doc_bl_no(app.doc_val(iv -> 'bl_number'))), 'packing', to_jsonb(app.doc_bl_no(app.doc_val(pk -> 'bl_number'))))), 'text'),
      app.doc_cmp_row('container_numbers', jsonb_build_object(
          'bl', (SELECT coalesce(jsonb_agg(c -> 'container_number'), '[]') FROM jsonb_array_elements(v_ctr) c WHERE c ? 'container_number'),
          'invoice', coalesce(nullif(iv -> 'container_numbers', 'null'), '[]'),
          'packing', coalesce(nullif(pk -> 'container_numbers', 'null'), '[]')
                     || (SELECT coalesce(jsonb_agg(x -> 'container_number'), '[]') FROM jsonb_array_elements(v_pi) x
                          WHERE jsonb_typeof(x -> 'container_number') = 'string')), 'set'),
      app.doc_cmp_row('seal_numbers', jsonb_build_object(
          'bl', (SELECT coalesce(jsonb_agg(c -> 'seal_number'), '[]') FROM jsonb_array_elements(v_ctr) c WHERE jsonb_typeof(c -> 'seal_number') = 'string'),
          'invoice', coalesce(nullif(iv -> 'seal_numbers', 'null'), '[]'),
          'packing', coalesce(nullif(pk -> 'seal_numbers', 'null'), '[]')
                     || (SELECT coalesce(jsonb_agg(x -> 'seal_number'), '[]') FROM jsonb_array_elements(v_pi) x
                          WHERE jsonb_typeof(x -> 'seal_number') = 'string')), 'set'),
      app.doc_cmp_row('net_weight', jsonb_strip_nulls(jsonb_build_object('bl', s -> 'net_weight', 'invoice', to_jsonb(v_inv_net),
          'packing', pk -> 'total_net_weight')), 'num'),
      app.doc_cmp_row('gross_weight', jsonb_strip_nulls(jsonb_build_object('bl', s -> 'gross_weight', 'packing', pk -> 'total_gross_weight')), 'num'),
      app.doc_cmp_row('packages_count', jsonb_strip_nulls(jsonb_build_object('bl', s -> 'packages_count', 'invoice', to_jsonb(v_inv_pkg),
          'packing', pk -> 'total_packages')), 'num'),
      -- REVIEW: both sides reduced to the identity name (legacy normalizeDocumentDraft_ on consignee and buyer)
      app.doc_cmp_row('consignee_buyer', jsonb_strip_nulls(jsonb_build_object(
          'bl', to_jsonb(app.consignee_identity_name(coalesce(app.doc_val(s -> 'consignee_name'), app.doc_val(s -> 'consignee')))),
          'invoice', to_jsonb(app.consignee_identity_name(app.doc_val(iv -> 'buyer'))))), 'text'),
      app.doc_cmp_row('shipper_seller', jsonb_strip_nulls(jsonb_build_object('bl', s -> 'shipper', 'invoice', iv -> 'seller')), 'text')]) x
    WHERE x IS NOT NULL LOOP
    v_rows := v_rows || jsonb_build_array(r);
  END LOOP;
  -- the required-fields checklist (legacy order)
  IF app.doc_val(s -> 'consignee_name') IS NULL AND app.doc_val(s -> 'consignee') IS NULL AND app.doc_val(iv -> 'buyer') IS NULL THEN v_missing := array_append(v_missing, 'consignee'); END IF;
  IF coalesce(app.doc_bl_no(app.doc_val(s -> 'bl_number')), app.doc_bl_no(app.doc_val(iv -> 'bl_number')), app.doc_bl_no(app.doc_val(pk -> 'bl_number'))) IS NULL THEN v_missing := array_append(v_missing, 'bl_number'); END IF;
  IF jsonb_array_length(v_ctr) = 0 AND jsonb_array_length(coalesce(nullif(iv -> 'container_numbers', 'null'), '[]')) = 0
     AND jsonb_array_length(coalesce(nullif(pk -> 'container_numbers', 'null'), '[]')) = 0 THEN v_missing := array_append(v_missing, 'container_number'); END IF;
  IF app.doc_val(s -> 'goods_description') IS NULL AND app.doc_val(v_ii -> 0 -> 'description') IS NULL THEN v_missing := array_append(v_missing, 'goods_description'); END IF;
  IF coalesce(app.doc_val(s -> 'packages_count'), app.doc_val(pk -> 'total_packages')) IS NULL THEN v_missing := array_append(v_missing, 'packages_count'); END IF;
  IF coalesce(app.doc_val(s -> 'net_weight'), app.doc_val(pk -> 'total_net_weight')) IS NULL THEN v_missing := array_append(v_missing, 'net_weight'); END IF;
  IF coalesce(app.doc_val(s -> 'gross_weight'), app.doc_val(pk -> 'total_gross_weight')) IS NULL THEN v_missing := array_append(v_missing, 'gross_weight'); END IF;
  IF app.doc_val(iv -> 'invoice_number') IS NULL THEN v_missing := array_append(v_missing, 'invoice_number'); END IF;
  IF app.doc_val(iv -> 'invoice_date') IS NULL THEN v_missing := array_append(v_missing, 'invoice_date'); END IF;
  IF app.doc_val(iv -> 'currency') IS NULL THEN v_missing := array_append(v_missing, 'currency'); END IF;
  IF app.doc_val(iv -> 'total') IS NULL THEN v_missing := array_append(v_missing, 'total'); END IF;
  IF app.doc_val(iv -> 'incoterms') IS NULL THEN v_missing := array_append(v_missing, 'incoterms'); END IF;
  IF jsonb_array_length(v_ii) = 0 THEN v_missing := array_append(v_missing, 'invoice_items'); END IF;
  IF jsonb_array_length(v_pi) = 0 THEN v_missing := array_append(v_missing, 'packing_items'); END IF;
  RETURN jsonb_build_object(
    'engine', 'batch-v1',
    'matches', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(v_rows) x WHERE x ->> 'status' = 'match'), '[]'::jsonb),
    'conflicts', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(v_rows) x WHERE x ->> 'status' = 'conflict'), '[]'::jsonb),
    'missing_fields', to_jsonb(v_missing));
END $$;

-- one reading → its section of a draft (fields reviewed by staff win over the machine fields)
CREATE OR REPLACE FUNCTION app.doc_reading_section(e public.document_extractions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(e.extracted_fields, '{}'::jsonb) || coalesce(e.reviewed_fields, '{}'::jsonb);
  v_ctr jsonb; v_seals jsonb; v_items jsonb; v_types text[]; v_item_sec text; v_out jsonb := '{}'::jsonb; v_bl jsonb;
  nf text[] := ARRAY['packages_count','net_weight','gross_weight','measurement_cbm','temperature_c','total'];
BEGIN
  f := (SELECT coalesce(jsonb_object_agg(k, CASE WHEN k = ANY (nf) THEN coalesce(to_jsonb(app.doc_num(v)), 'null'::jsonb) ELSE v END), '{}')
          FROM jsonb_each(f) AS j(k, v) WHERE jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') <> '');
  v_ctr := (SELECT coalesce(jsonb_agg(jsonb_build_object('container_number', x -> 'container_number',
               'seal_number', to_jsonb(left(x ->> 'seal_number', 30)), 'size_type', to_jsonb(left(x ->> 'size_type', 10)),
               'packages_count', CASE WHEN jsonb_typeof(x -> 'packages_count') = 'number' THEN x -> 'packages_count' END,
               'net_weight', CASE WHEN jsonb_typeof(x -> 'net_weight') = 'number' THEN x -> 'net_weight' END,
               'gross_weight', CASE WHEN jsonb_typeof(x -> 'gross_weight') = 'number' THEN x -> 'gross_weight' END) ORDER BY o), '[]')
               FROM jsonb_array_elements(coalesce(e.ai_detail -> 'containers', '[]')) WITH ORDINALITY AS u(x, o)
             WHERE coalesce(x ->> 'container_number', '') ~ '^[A-Z]{4}[0-9]{7}$');
  -- containers only listed in container_numbers (OCR / v2 readings) become rows too
  v_ctr := v_ctr || (SELECT coalesce(jsonb_agg(jsonb_build_object('container_number', c)), '[]')
                       FROM unnest(regexp_split_to_array(coalesce(f ->> 'container_numbers', ''), '[,;[:space:]]+')) c
                      WHERE c ~ '^[A-Z]{4}[0-9]{7}$'
                        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ctr) y WHERE y ->> 'container_number' = c));
  v_seals := (SELECT coalesce(jsonb_agg(DISTINCT s), '[]') FROM unnest(regexp_split_to_array(coalesce(f ->> 'seal_numbers', ''), '[,;[:space:]]+')) s
               WHERE s <> '' AND char_length(s) <= 40);
  -- REVIEW: a combined file (legacy detectedDocuments) fills the section of every document type found in it; the goods
  -- table goes to the reading's own invoice / packing section (else the first of them found in the file)
  v_types := ARRAY[e.doc_type] || coalesce((SELECT array_agg(DISTINCT t) FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(e.ai_detail -> 'detected_documents') = 'array' THEN e.ai_detail -> 'detected_documents' ELSE '[]'::jsonb END) t), '{}');
  v_item_sec := CASE WHEN e.doc_type IN ('commercial_invoice','packing_list') THEN e.doc_type
                     WHEN 'commercial_invoice' = ANY (v_types) THEN 'commercial_invoice'
                     WHEN 'packing_list' = ANY (v_types) THEN 'packing_list' END;
  v_bl := to_jsonb(app.doc_bl_no(f ->> 'bl_number'));                          -- REVIEW: legacy normalizeValidBillNo_
  IF 'bill_of_lading' = ANY (v_types) THEN
    v_out := v_out || jsonb_build_object('shipment', jsonb_strip_nulls(jsonb_build_object(
      'shipper', f -> 'shipper', 'consignee', f -> 'consignee',
      'consignee_name', coalesce(f -> 'consignee_name', to_jsonb(app.consignee_identity_name(f ->> 'consignee'))),
      'notify_party', f -> 'notify_party', 'booking_number', f -> 'booking_number', 'bl_number', v_bl,
      'vessel', f -> 'vessel', 'voyage', f -> 'voyage', 'port_of_loading', f -> 'port_of_loading', 'port_of_discharge', f -> 'port_of_discharge',
      'place_of_receipt', f -> 'place_of_receipt', 'place_of_delivery', f -> 'place_of_delivery', 'freight_terms', f -> 'freight_terms',
      'goods_description', f -> 'goods_description', 'packages_count', f -> 'packages_count', 'package_type', f -> 'package_type',
      'net_weight', f -> 'net_weight', 'gross_weight', f -> 'gross_weight', 'measurement_cbm', f -> 'measurement_cbm',
      'temperature_c', f -> 'temperature_c', 'shipping_line', f -> 'shipping_line'))
      || jsonb_build_object('containers', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(x) ||
             CASE WHEN NOT (x ? 'seal_number') AND jsonb_array_length(v_ctr) = 1 AND jsonb_array_length(v_seals) = 1
                  THEN jsonb_build_object('seal_number', v_seals -> 0) ELSE '{}'::jsonb END), '[]')
             FROM jsonb_array_elements(v_ctr) x)));
  END IF;
  IF 'commercial_invoice' = ANY (v_types) THEN
    v_items := CASE WHEN v_item_sec = 'commercial_invoice' THEN
               (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('description', it -> 'description',
                 'scientific_name', it -> 'scientific_name', 'supplier_hs_code', it -> 'hs_code', 'quantity', it -> 'quantity',
                 'unit', it -> 'unit', 'unit_price', it -> 'unit_price', 'total', it -> 'amount', 'origin_country', it -> 'origin_country',
                 'net_weight', it -> 'net_weight', 'gross_weight', it -> 'gross_weight', 'notes', it -> 'notes',
                 'invoice_number', f -> 'invoice_number')) ORDER BY o), '[]')
                  FROM jsonb_array_elements(coalesce(e.line_items, '[]')) WITH ORDINALITY AS u(it, o)) ELSE '[]'::jsonb END;
    v_out := v_out || jsonb_build_object('invoice', jsonb_strip_nulls(jsonb_build_object(
      'invoice_number', f -> 'invoice_number', 'invoice_date', f -> 'invoice_date', 'seller', f -> 'supplier_name',
      'buyer', coalesce(f -> 'buyer_name', f -> 'consignee_name'), 'currency', f -> 'currency', 'country_of_origin', f -> 'country_of_origin',
      'export_country', f -> 'export_country', 'total', f -> 'total', 'incoterms', f -> 'incoterms', 'payment_terms', f -> 'payment_terms',
      'bl_number', v_bl, 'vessel', f -> 'vessel', 'voyage', f -> 'voyage', 'port_of_loading', f -> 'port_of_loading',
      'port_of_discharge', f -> 'port_of_discharge'))
      || jsonb_build_object('container_numbers', (SELECT coalesce(jsonb_agg(x -> 'container_number'), '[]') FROM jsonb_array_elements(v_ctr) x),
                            'seal_numbers', v_seals, 'items', v_items));
  END IF;
  IF 'packing_list' = ANY (v_types) THEN
    v_items := CASE WHEN v_item_sec = 'packing_list' THEN
               (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('description', it -> 'description',
                 'packages', it -> 'packages', 'quantity', it -> 'quantity', 'unit', it -> 'unit', 'net_weight', it -> 'net_weight',
                 'gross_weight', it -> 'gross_weight', 'container_number', it -> 'container_number', 'seal_number', it -> 'seal_number',
                 'notes', it -> 'notes', 'packing_list_number', f -> 'packing_list_number')) ORDER BY o), '[]')
                  FROM jsonb_array_elements(coalesce(e.line_items, '[]')) WITH ORDINALITY AS u(it, o)) ELSE '[]'::jsonb END;
    v_out := v_out || jsonb_build_object('packing', jsonb_strip_nulls(jsonb_build_object(
      'packing_list_number', f -> 'packing_list_number', 'packing_list_date', f -> 'packing_list_date',
      'total_packages', f -> 'packages_count', 'package_type', f -> 'package_type', 'total_net_weight', f -> 'net_weight',
      'total_gross_weight', f -> 'gross_weight', 'bl_number', v_bl, 'vessel', f -> 'vessel', 'voyage', f -> 'voyage',
      'port_of_loading', f -> 'port_of_loading', 'port_of_discharge', f -> 'port_of_discharge'))
      || jsonb_build_object('container_numbers', (SELECT coalesce(jsonb_agg(x -> 'container_number'), '[]') FROM jsonb_array_elements(v_ctr) x),
                            'seal_numbers', v_seals, 'items', v_items));
  END IF;
  IF 'customs_declaration' = ANY (v_types) THEN
    v_out := v_out || jsonb_build_object('declaration', jsonb_strip_nulls(jsonb_build_object('declaration_number', f -> 'declaration_number')));
  END IF;
  RETURN v_out;
END $$;

-- legacy mergeDocumentDrafts_ over the live readings of a batch (slot order, then attach order): a non-empty incoming value
-- wins; containers merge by number (non-empty values fill in); item lists of several invoices / packing lists are joined;
-- source notes unioned. → {draft, merge_conflicts: [{section, field, values: [{slot, seq, value}]}]} (two readings of the
-- same section that disagree on a field: the reviewer chooses)
CREATE OR REPLACE FUNCTION app.doc_batch_merge(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d record; v_sec jsonb; v_name text; v_obj jsonb; v_draft jsonb := '{}'::jsonb; v_seen jsonb := '{}'::jsonb;
  e record; v_conf jsonb := '[]'::jsonb; v_ctr jsonb; c jsonb; v_map jsonb := '{}'::jsonb; v_order text[] := '{}'; k text;
  v_prev jsonb;
BEGIN
  FOR d IN SELECT bd.slot, bd.seq, x AS ext FROM public.doc_batch_documents bd JOIN public.document_extractions x ON x.id = bd.extraction_id
            WHERE bd.batch_id = p_batch AND bd.detached_at IS NULL AND x.voided_at IS NULL
            ORDER BY array_position(ARRAY['bill_of_lading','commercial_invoice','packing_list','customs_declaration'], bd.slot), bd.seq LOOP
    v_sec := app.doc_reading_section(d.ext);
    FOR v_name, v_obj IN SELECT key, value FROM jsonb_each(v_sec) LOOP
      v_prev := coalesce(v_draft -> v_name, '{}'::jsonb);
      FOR e IN SELECT key, value FROM jsonb_each(v_obj) LOOP
        IF e.key IN ('items') THEN
          -- a draft holds ≤ 500 items per section: the rest is reported, never silently dropped
          IF jsonb_array_length(coalesce(v_prev -> 'items', '[]')) + jsonb_array_length(e.value) > 500 THEN
            v_conf := v_conf || jsonb_build_array(jsonb_build_object('section', v_name, 'field', 'items_truncated', 'values', jsonb_build_array(
              jsonb_build_object('slot', d.slot, 'seq', d.seq, 'value', jsonb_array_length(coalesce(v_prev -> 'items', '[]')) + jsonb_array_length(e.value)))));
          END IF;
          v_prev := jsonb_set(v_prev, '{items}', (SELECT coalesce(jsonb_agg(z ORDER BY o), '[]') FROM jsonb_array_elements(coalesce(v_prev -> 'items', '[]') || e.value)
                                                    WITH ORDINALITY AS u(z, o) WHERE o <= 500));
        ELSIF e.key IN ('container_numbers','seal_numbers') THEN
          v_prev := jsonb_set(v_prev, ARRAY[e.key], (SELECT coalesce(jsonb_agg(DISTINCT z), '[]') FROM jsonb_array_elements(coalesce(v_prev -> e.key, '[]') || e.value) z));
          -- a container only printed on an invoice / packing list is still a container of the shipment
          IF e.key = 'container_numbers' THEN
            FOR c IN SELECT z FROM jsonb_array_elements(e.value) z LOOP
              k := c #>> '{}';
              IF k ~ '^[A-Z]{4}[0-9]{7}$' AND NOT v_map ? k THEN
                v_order := v_order || k; v_map := v_map || jsonb_build_object(k, jsonb_build_object('container_number', k));
              END IF;
            END LOOP;
          END IF;
        ELSIF e.key = 'containers' THEN
          FOR c IN SELECT x FROM jsonb_array_elements(e.value) x LOOP
            k := c ->> 'container_number';
            IF NOT v_map ? k THEN v_order := v_order || k; v_map := v_map || jsonb_build_object(k, c);
            ELSE v_map := jsonb_set(v_map, ARRAY[k], (v_map -> k) || jsonb_strip_nulls(c)); END IF;
          END LOOP;
        ELSIF app.doc_val(e.value) IS NOT NULL THEN
          IF v_prev ? e.key AND app.legacy_search_key(app.doc_val(v_prev -> e.key)) IS DISTINCT FROM app.legacy_search_key(app.doc_val(e.value)) THEN
            v_conf := v_conf || jsonb_build_array(jsonb_build_object('section', v_name, 'field', e.key, 'values', jsonb_build_array(
              jsonb_build_object('slot', v_seen #>> ARRAY[v_name, e.key, 'slot'], 'seq', (v_seen #>> ARRAY[v_name, e.key, 'seq'])::int, 'value', v_prev -> e.key),
              jsonb_build_object('slot', d.slot, 'seq', d.seq, 'value', e.value))));
          END IF;
          v_prev := v_prev || jsonb_build_object(e.key, e.value);
          v_seen := jsonb_set(CASE WHEN v_seen ? v_name THEN v_seen ELSE v_seen || jsonb_build_object(v_name, '{}'::jsonb) END,
                              ARRAY[v_name, e.key], jsonb_build_object('slot', d.slot, 'seq', d.seq));
        END IF;
      END LOOP;
      v_draft := v_draft || jsonb_build_object(v_name, v_prev);
    END LOOP;
  END LOOP;
  -- every container read on any document is a row of the shipment (B/L first)
  v_ctr := (SELECT coalesce(jsonb_agg(v_map -> n ORDER BY o), '[]') FROM unnest(v_order) WITH ORDINALITY AS u(n, o));
  IF jsonb_array_length(v_ctr) > 0 OR v_draft ? 'shipment' THEN
    v_draft := jsonb_set(CASE WHEN v_draft ? 'shipment' THEN v_draft ELSE v_draft || '{"shipment":{}}'::jsonb END, '{shipment,containers}', v_ctr);
  END IF;
  RETURN jsonb_build_object('draft', v_draft, 'merge_conflicts', v_conf);
END $$;

-- REVIEW: legacy mergeDocumentDrafts_(base, incoming) — the draft of a later batch laid over the approved one: per section a
-- non-empty incoming value wins (empty / zero / null keeps the base), a non-empty list (container / seal numbers) replaces
-- the base list, containers merge by number (non-empty values fill in), an item list replaces the base items only when it
-- has items, source notes are unioned. → the combined draft
CREATE OR REPLACE FUNCTION app.doc_draft_overlay(p_base jsonb, p_top jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_out jsonb := coalesce(p_base, '{}'::jsonb); v_sec text; b jsonb; t jsonb; e record; v_map jsonb; v_order text[]; c jsonb; k text;
BEGIN
  IF p_top IS NULL OR jsonb_typeof(p_top) <> 'object' THEN RETURN v_out; END IF;
  FOREACH v_sec IN ARRAY ARRAY['shipment','invoice','packing','declaration'] LOOP
    t := p_top -> v_sec;
    CONTINUE WHEN t IS NULL OR jsonb_typeof(t) <> 'object';
    b := CASE WHEN jsonb_typeof(v_out -> v_sec) = 'object' THEN v_out -> v_sec ELSE '{}'::jsonb END;
    FOR e IN SELECT key, value FROM jsonb_each(t) LOOP
      IF e.key = 'containers' THEN
        v_map := '{}'::jsonb; v_order := '{}';
        FOR c IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b -> 'containers') = 'array' THEN b -> 'containers' ELSE '[]'::jsonb END
                                                    || CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END) x LOOP
          k := c ->> 'container_number';
          CONTINUE WHEN k IS NULL;
          IF NOT v_map ? k THEN v_order := v_order || k; v_map := v_map || jsonb_build_object(k, c);
          ELSE v_map := jsonb_set(v_map, ARRAY[k], (v_map -> k) || (SELECT coalesce(jsonb_object_agg(y.key, y.value), '{}'::jsonb)
                                                                    FROM jsonb_each(c) y WHERE app.doc_val(y.value) IS NOT NULL)); END IF;
        END LOOP;
        b := b || jsonb_build_object('containers', (SELECT coalesce(jsonb_agg(v_map -> n ORDER BY o), '[]'::jsonb)
                                                     FROM unnest(v_order) WITH ORDINALITY AS u(n, o)));
      ELSIF jsonb_typeof(e.value) = 'array' THEN
        IF jsonb_array_length(e.value) > 0 OR NOT b ? e.key THEN b := b || jsonb_build_object(e.key, e.value); END IF;
      ELSIF app.doc_val(e.value) IS NOT NULL OR NOT b ? e.key THEN
        b := b || jsonb_build_object(e.key, e.value);
      END IF;
    END LOOP;
    v_out := v_out || jsonb_build_object(v_sec, b);
  END LOOP;
  IF jsonb_typeof(p_top -> 'source_notes') = 'array' THEN
    v_out := v_out || jsonb_build_object('source_notes', (SELECT coalesce(jsonb_agg(DISTINCT z), '[]'::jsonb) FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_out -> 'source_notes') = 'array' THEN v_out -> 'source_notes' ELSE '[]'::jsonb END || (p_top -> 'source_notes')) z));
  END IF;
  RETURN v_out;
END $$;

-- alias learning (legacy saveCustomerAliasFromReviewedMatch_): p_status 'approved' (a staff confirmation: the alias is
-- created or upgraded, +1 occurrence, client match statistics) or 'suggested' (only created when absent; never downgrades).
-- The name equal to the client's own name needs no alias (statistics only). → {alias_id, status, occurrences, created}
CREATE OR REPLACE FUNCTION app.client_alias_learn(p_org uuid, p_client uuid, p_name text, p_status text, p_source text,
  p_ref text, p_confidence int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.clients; a public.client_aliases; v_name text := app.consignee_identity_name(p_name); v_norm text; v_created boolean := false;
BEGIN
  SELECT * INTO c FROM public.clients x WHERE x.id = p_client AND x.org_id = p_org;
  IF c.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  IF v_name IS NULL OR char_length(v_name) < 2 THEN RETURN jsonb_build_object('alias_id', NULL, 'status', NULL, 'occurrences', 0, 'created', false); END IF;
  v_norm := app.norm_name(v_name);
  IF p_status = 'approved' THEN
    UPDATE public.clients x SET match_count = x.match_count + 1, last_matched_at = now(),
           name_en = CASE WHEN x.name_en IS NULL AND v_name ~ '[A-Za-z]' AND v_name !~ '[؀-ۿ]' THEN left(v_name, 160) ELSE x.name_en END
     WHERE x.id = c.id;
  END IF;
  IF v_norm IS NULL OR v_norm = app.norm_name(c.name_ar) OR v_norm = app.norm_name(c.name_en) THEN
    RETURN jsonb_build_object('alias_id', NULL, 'status', NULL, 'occurrences', 0, 'created', false);
  END IF;
  SELECT * INTO a FROM public.client_aliases x WHERE x.org_id = p_org AND x.alias_norm = v_norm FOR UPDATE;
  IF a.id IS NOT NULL AND a.client_id <> c.id THEN
    -- the name already belongs to another client: an approved alias is a conflict for a confirmation (a suggestion is
    -- simply not made); a suggested / rejected one moves to the client the staff member confirmed
    IF p_status <> 'approved' THEN
      RETURN jsonb_build_object('alias_id', NULL, 'status', NULL, 'occurrences', 0, 'created', false);
    END IF;
    IF a.status = 'approved' THEN PERFORM app.fail('MRS_CLIENT_ALIAS_CONFLICT'); END IF;
    UPDATE public.client_aliases x SET client_id = c.id, status = 'approved', occurrences = 1, last_used_at = now(),
           confidence = p_confidence, source_ref = coalesce(left(p_ref, 120), x.source_ref), approved_by = auth.uid(), approved_at = now()
     WHERE x.id = a.id RETURNING * INTO a;
    RETURN jsonb_build_object('alias_id', a.id, 'status', a.status, 'occurrences', a.occurrences, 'created', false);
  END IF;
  IF a.id IS NULL THEN
    INSERT INTO public.client_aliases (org_id, client_id, alias, source, created_by, status, confidence, occurrences, last_used_at,
                                       source_ref, approved_by, approved_at)
    VALUES (p_org, c.id, left(v_name, 160), p_source, auth.uid(), p_status, p_confidence, 1, now(), left(p_ref, 120),
            CASE WHEN p_status = 'approved' THEN auth.uid() END, CASE WHEN p_status = 'approved' THEN now() END)
    RETURNING * INTO a;
    v_created := true;
  ELSIF p_status = 'approved' THEN
    UPDATE public.client_aliases x SET status = 'approved', occurrences = x.occurrences + 1, last_used_at = now(),
           confidence = coalesce(p_confidence, x.confidence), source_ref = coalesce(left(p_ref, 120), x.source_ref),
           approved_by = auth.uid(), approved_at = now()
     WHERE x.id = a.id RETURNING * INTO a;
  END IF;
  RETURN jsonb_build_object('alias_id', a.id, 'status', a.status, 'occurrences', a.occurrences, 'created', v_created);
END $$;

-- the caller may read this batch: staff of its branch
CREATE OR REPLACE FUNCTION app.doc_batch_visible(p_org uuid, p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.has_branch_role(p_org, p_branch, app.staff_roles())
$$;

-- a batch for writing: visible, ops writer on its branch, FOR UPDATE; p_draft_only → status draft
CREATE OR REPLACE FUNCTION app.doc_batch_lock(p_batch uuid, p_draft_only boolean) RETURNS public.doc_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.doc_batches;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO b FROM public.doc_batches x WHERE x.id = p_batch FOR UPDATE;
  IF b.id IS NULL OR NOT app.doc_batch_visible(b.org_id, b.branch_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'doc_batch'); END IF;
  IF NOT app.has_branch_role(b.org_id, b.branch_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF p_draft_only AND b.status <> 'draft' THEN PERFORM app.fail('MRS_DOC_BATCH_STATE', b.status); END IF;
  RETURN b;
END $$;

-- a batch as JSON (p_full: + draft, comparison, client_match, documents)
CREATE OR REPLACE FUNCTION app.doc_batch_json(b public.doc_batches, p_full boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', b.id, 'org_id', b.org_id, 'branch_id', b.branch_id, 'kind', b.kind, 'status', b.status, 'version', b.version,
    'transaction_id', b.transaction_id, 'transaction_ref', (SELECT t.ref FROM public.transactions t WHERE t.id = b.transaction_id),
    'client_id', b.client_id, 'client_name', (SELECT c.name_ar FROM public.clients c WHERE c.id = b.client_id),
    'bl_number', b.bl_number, 'importer_name', b.importer_name, 'container_count', b.container_count,
    'document_count', (SELECT count(*) FROM public.doc_batch_documents d WHERE d.batch_id = b.id AND d.detached_at IS NULL),
    'slots', (SELECT jsonb_build_object(
        'bill_of_lading', count(*) FILTER (WHERE d.slot = 'bill_of_lading'),
        'commercial_invoice', count(*) FILTER (WHERE d.slot = 'commercial_invoice'),
        'packing_list', count(*) FILTER (WHERE d.slot = 'packing_list'),
        'customs_declaration', count(*) FILTER (WHERE d.slot = 'customs_declaration'))
        FROM public.doc_batch_documents d WHERE d.batch_id = b.id AND d.detached_at IS NULL),
    'conflicts_count', jsonb_array_length(coalesce(b.comparison -> 'conflicts', '[]')),
    'missing_count', jsonb_array_length(coalesce(b.comparison -> 'missing_fields', '[]')),
    'note', b.note, 'created_by', b.created_by,
    'created_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = b.created_by),
    'created_at', b.created_at, 'updated_by', b.updated_by, 'updated_at', b.updated_at,
    'approved_by', b.approved_by, 'approved_at', b.approved_at, 'created_transaction', b.created_transaction,
    'closed_by', b.closed_by, 'closed_at', b.closed_at, 'close_reason', b.close_reason)
  || CASE WHEN p_full THEN jsonb_build_object(
    'draft', b.draft, 'comparison', b.comparison, 'client_match', b.client_match, 'approve_result', b.approve_result,
    'documents', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'slot', d.slot, 'seq', d.seq, 'extraction_id', d.extraction_id, 'detected_type', d.detected_type,
        'doc_type', x.doc_type, 'source_name', x.source_name, 'source_sha256', x.source_sha256, 'engine', x.engine,
        'prompt_version', x.ai_detail ->> 'prompt_version', 'mean_confidence', x.mean_confidence, 'review_status', x.review_status,
        'extraction_transaction_id', x.transaction_id, 'extraction_voided', x.voided_at IS NOT NULL,
        'created_by', d.created_by, 'created_at', d.created_at)
        ORDER BY array_position(ARRAY['bill_of_lading','commercial_invoice','packing_list','customs_declaration'], d.slot), d.seq), '[]')
        FROM public.doc_batch_documents d JOIN public.document_extractions x ON x.id = d.extraction_id
       WHERE d.batch_id = b.id AND d.detached_at IS NULL)) ELSE '{}'::jsonb END
$$;

-- ---------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------
-- create_doc_batch(p_org, {transaction_id?, branch_id?, note?, idempotencyKey?}) — ops writer. The branch: the
-- transaction's, else branch_id, else the caller's only branch, else the org's only active branch (else MRS_REQUIRED
-- branch_id). → the batch (app.doc_batch_json, full)
CREATE OR REPLACE FUNCTION public.create_doc_batch(p_org uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_key uuid; v_replay jsonb; v_tx public.transactions; v_branch uuid; b public.doc_batches; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p, ARRAY['transaction_id','branch_id','note','idempotencyKey']);
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('create_doc_batch', v_key, p - 'idempotencyKey', p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF app.puuid(p, 'transaction_id') IS NOT NULL THEN
    v_tx := app.g3_lock_tx(app.puuid(p, 'transaction_id'), app.ops_writer_roles());
    IF v_tx.org_id <> p_org THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
    v_branch := v_tx.branch_id;
  ELSE
    v_branch := app.puuid(p, 'branch_id');
    IF v_branch IS NULL THEN
      SELECT CASE WHEN count(DISTINCT m.branch_id) = 1 AND bool_and(m.branch_id IS NOT NULL) THEN min(m.branch_id::text)::uuid END INTO v_branch
        FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (app.ops_writer_roles());
    END IF;
    IF v_branch IS NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN min(x.id::text)::uuid END INTO v_branch FROM public.branches x WHERE x.org_id = p_org AND x.is_active;
    END IF;
    IF v_branch IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'branch_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.branches x WHERE x.id = v_branch AND x.org_id = p_org AND x.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'branch_id');
    END IF;
    IF NOT app.has_branch_role(p_org, v_branch, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'branch'); END IF;
  END IF;
  INSERT INTO public.doc_batches (org_id, branch_id, transaction_id, note, created_by, updated_by)
  VALUES (p_org, v_branch, v_tx.id, app.ptext(p, 'note', 1000), auth.uid(), auth.uid())
  RETURNING * INTO b;
  v_res := app.doc_batch_json(b, true);
  PERFORM app.idem_finish('create_doc_batch', v_key, v_res);
  RETURN v_res;
END $$;

-- attach_doc_batch_document(p_batch, {extraction_id, slot}) — ops writer, draft batch. Wrong-slot guard: the reading's
-- doc_type and (ai-doc-v3) detected type must be the slot (MRS_DOC_WRONG_SLOT <slot>:<detected>). The reading: of the org,
-- visible, not voided, not in another open batch (draft / approved: MRS_DOC_IN_OTHER_BATCH), of the batch's transaction
-- (a batch without one adopts the reading's); the same file only once per batch. Capacity: one B/L, one declaration, ≤ 10
-- invoices, ≤ 10 packing lists. Attaching the same reading again returns it (already_attached). → {document, batch}
CREATE OR REPLACE FUNCTION public.attach_doc_batch_document(p_batch uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  b public.doc_batches; e public.document_extractions; v_slot text; v_det text; v_seq int; v_max int; d public.doc_batch_documents;
  v_tx public.transactions; v_again boolean := false;
BEGIN
  b := app.doc_batch_lock(p_batch, true);
  PERFORM app.only_keys(p_payload, ARRAY['extraction_id','slot']);
  v_slot := app.ptext(p_payload, 'slot', 40, true);
  IF v_slot NOT IN ('bill_of_lading','commercial_invoice','packing_list','customs_declaration') THEN PERFORM app.fail('MRS_INVALID', 'slot'); END IF;
  IF app.puuid(p_payload, 'extraction_id') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'extraction_id'); END IF;
  SELECT * INTO e FROM public.document_extractions x WHERE x.id = app.puuid(p_payload, 'extraction_id') AND x.org_id = b.org_id FOR SHARE;
  IF e.id IS NULL OR (e.transaction_id IS NOT NULL AND NOT app.has_tx_role(e.transaction_id, app.staff_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'extraction');
  END IF;
  IF e.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_DOC_VOIDED', 'extraction'); END IF;
  SELECT * INTO d FROM public.doc_batch_documents x WHERE x.batch_id = b.id AND x.extraction_id = e.id AND x.detached_at IS NULL;
  IF d.id IS NOT NULL THEN
    IF d.slot <> v_slot THEN PERFORM app.fail('MRS_DOC_WRONG_SLOT', v_slot || ':' || d.slot); END IF;
    v_again := true;
  ELSE
    -- the model's detected type (ai-doc-v3), else the saved kind
    v_det := coalesce(CASE WHEN e.ai_detail ->> 'detected_type' = 'supplier_invoice' THEN 'operator_invoice' ELSE e.ai_detail ->> 'detected_type' END, e.doc_type);
    -- REVIEW: a combined file is accepted in the slot of any document type found in it (legacy assertExpectedDocumentType_)
    IF v_det <> v_slot AND jsonb_typeof(e.ai_detail -> 'detected_documents') = 'array' AND (e.ai_detail -> 'detected_documents') ? v_slot THEN
      v_det := v_slot;
    END IF;
    IF e.doc_type <> v_slot OR v_det <> v_slot THEN
      PERFORM app.fail('MRS_DOC_WRONG_SLOT', v_slot || ':' || CASE WHEN e.doc_type <> v_slot THEN e.doc_type ELSE v_det END);
    END IF;
    IF EXISTS (SELECT 1 FROM public.doc_batch_documents x JOIN public.doc_batches y ON y.id = x.batch_id
                WHERE x.extraction_id = e.id AND x.detached_at IS NULL AND y.id <> b.id AND y.status IN ('draft','approved')) THEN
      PERFORM app.fail('MRS_DOC_IN_OTHER_BATCH');
    END IF;
    IF EXISTS (SELECT 1 FROM public.doc_batch_documents x JOIN public.document_extractions y ON y.id = x.extraction_id
                WHERE x.batch_id = b.id AND x.detached_at IS NULL AND y.source_sha256 = e.source_sha256) THEN
      PERFORM app.fail('MRS_INVALID', 'duplicate_file');
    END IF;
    -- one transaction for the whole batch
    IF e.transaction_id IS NOT NULL THEN
      IF b.transaction_id IS NULL THEN
        v_tx := app.g3_lock_tx(e.transaction_id, app.ops_writer_roles());
        UPDATE public.doc_batches x SET transaction_id = v_tx.id, branch_id = v_tx.branch_id, updated_by = auth.uid(), updated_at = now()
         WHERE x.id = b.id RETURNING * INTO b;
      ELSIF b.transaction_id <> e.transaction_id THEN
        PERFORM app.fail('MRS_INVALID', 'transaction_id');
      END IF;
    END IF;
    v_max := CASE WHEN v_slot IN ('bill_of_lading','customs_declaration') THEN 1 ELSE 10 END;
    SELECT coalesce(max(x.seq), 0) + 1 INTO v_seq FROM public.doc_batch_documents x
     WHERE x.batch_id = b.id AND x.slot = v_slot AND x.detached_at IS NULL;
    IF (SELECT count(*) FROM public.doc_batch_documents x WHERE x.batch_id = b.id AND x.slot = v_slot AND x.detached_at IS NULL) >= v_max
       OR v_seq > 10 THEN
      PERFORM app.fail('MRS_INVALID', 'slot_full');
    END IF;
    INSERT INTO public.doc_batch_documents (org_id, batch_id, slot, seq, extraction_id, detected_type, created_by)
    VALUES (b.org_id, b.id, v_slot, v_seq, e.id, v_det, auth.uid())
    RETURNING * INTO d;
    UPDATE public.doc_batches x SET updated_by = auth.uid(), updated_at = now() WHERE x.id = b.id RETURNING * INTO b;
  END IF;
  RETURN jsonb_build_object('document', jsonb_build_object('id', d.id, 'slot', d.slot, 'seq', d.seq, 'extraction_id', d.extraction_id,
           'detected_type', d.detected_type, 'created_at', d.created_at), 'already_attached', v_again,
           'batch', app.doc_batch_json(b, false));
END $$;

-- detach_doc_batch_document(p_document, p_reason) — ops writer, draft batch; void-only (the slot frees up)
CREATE OR REPLACE FUNCTION public.detach_doc_batch_document(p_document uuid, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.doc_batch_documents; b public.doc_batches;
  v_why text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO d FROM public.doc_batch_documents x WHERE x.id = p_document;
  IF d.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'doc_batch_document'); END IF;
  b := app.doc_batch_lock(d.batch_id, true);
  IF d.detached_at IS NOT NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'doc_batch_document'); END IF;
  IF char_length(v_why) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.doc_batch_documents x SET detached_at = now(), detached_by = auth.uid(), detach_reason = v_why WHERE x.id = d.id RETURNING * INTO d;
  UPDATE public.doc_batches x SET updated_by = auth.uid(), updated_at = now() WHERE x.id = b.id RETURNING * INTO b;
  RETURN jsonb_build_object('id', d.id, 'detached_at', d.detached_at, 'batch', app.doc_batch_json(b, false));
END $$;

-- merge_doc_batch(p_batch) — staff who can read the batch; read-only: the merged draft of the attached readings (legacy
-- merge), its merge conflicts and the comparison of that draft → {draft, merge_conflicts, comparison, version}
CREATE OR REPLACE FUNCTION public.merge_doc_batch(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.doc_batches; m jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO b FROM public.doc_batches x WHERE x.id = p_batch;
  IF b.id IS NULL OR NOT app.doc_batch_visible(b.org_id, b.branch_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'doc_batch'); END IF;
  m := app.doc_batch_merge(b.id);
  RETURN m || jsonb_build_object('comparison', app.doc_batch_compare(m -> 'draft'), 'version', b.version);
END $$;

-- save_doc_batch_draft(p_batch, {version, draft, client_match?, client_id?, note?}) — ops writer, draft batch, optimistic
-- (version = the version read, else MRS_DOC_BATCH_STALE). The comparison is recomputed here; bl_number / importer_name /
-- container_count follow the draft. → the batch (full)
CREATE OR REPLACE FUNCTION public.save_doc_batch_draft(p_batch uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.doc_batches; v_draft jsonb; v_bad text; v_ver jsonb; v_client uuid; v_cm jsonb;
BEGIN
  b := app.doc_batch_lock(p_batch, true);
  PERFORM app.only_keys(p_payload, ARRAY['version','draft','client_match','client_id','note']);
  v_ver := p_payload -> 'version';
  IF v_ver IS NULL OR jsonb_typeof(v_ver) <> 'number' THEN PERFORM app.fail('MRS_REQUIRED', 'version'); END IF;
  IF (v_ver #>> '{}')::numeric <> b.version THEN PERFORM app.fail('MRS_DOC_BATCH_STALE'); END IF;
  v_draft := coalesce(p_payload -> 'draft', b.draft);
  v_bad := app.doc_batch_draft_check(v_draft);
  IF v_bad IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', v_bad); END IF;
  v_cm := CASE WHEN p_payload ? 'client_match' THEN nullif(p_payload -> 'client_match', 'null'::jsonb) ELSE b.client_match END;
  IF v_cm IS NOT NULL AND (jsonb_typeof(v_cm) <> 'object' OR octet_length(v_cm::text) > 20000) THEN PERFORM app.fail('MRS_INVALID', 'client_match'); END IF;
  v_client := CASE WHEN p_payload ? 'client_id' THEN app.puuid(p_payload, 'client_id') ELSE b.client_id END;
  IF v_client IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client AND c.org_id = b.org_id) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'client');
  END IF;
  UPDATE public.doc_batches x SET
    draft = v_draft, comparison = app.doc_batch_compare(v_draft), client_match = v_cm, client_id = v_client,
    note = CASE WHEN p_payload ? 'note' THEN app.ptext(p_payload, 'note', 1000) ELSE x.note END,
    bl_number = left(coalesce(app.doc_bl_no(app.doc_val(v_draft #> '{shipment,bl_number}')), app.doc_bl_no(app.doc_val(v_draft #> '{invoice,bl_number}')),
                              app.doc_bl_no(app.doc_val(v_draft #> '{packing,bl_number}'))), 80),
    importer_name = left(coalesce(app.doc_val(v_draft #> '{shipment,consignee_name}'),
                                  app.consignee_identity_name(v_draft #>> '{shipment,consignee}'),
                                  app.consignee_identity_name(v_draft #>> '{invoice,buyer}')), 160),   -- REVIEW: = the alias approve learns
    container_count = jsonb_array_length(coalesce(nullif(v_draft #> '{shipment,containers}', 'null'), '[]')),
    version = x.version + 1, updated_by = auth.uid(), updated_at = now()
   WHERE x.id = b.id RETURNING * INTO b;
  RETURN app.doc_batch_json(b, true);
END $$;

-- get_doc_batch(p_batch) — staff who can read the batch → the batch (full)
CREATE OR REPLACE FUNCTION public.get_doc_batch(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.doc_batches;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO b FROM public.doc_batches x WHERE x.id = p_batch;
  IF b.id IS NULL OR NOT app.doc_batch_visible(b.org_id, b.branch_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'doc_batch'); END IF;
  RETURN app.doc_batch_json(b, true);
END $$;

-- list_pending_doc_batches(p_org, {status?: draft (default) | approved | discarded | archived | open (draft + discarded),
-- transaction_id?, limit? (≤ 200, default 50)}) — staff; only the batches of the caller's branches, newest change first.
-- → [batch (summary)]
CREATE OR REPLACE FUNCTION public.list_pending_doc_batches(p_org uuid, p_filter jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filter, '{}'::jsonb); v_status text; v_tx uuid; v_limit numeric;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  PERFORM app.only_keys(f, ARRAY['status','transaction_id','limit']);
  v_status := coalesce(app.ptext(f, 'status', 20), 'draft');
  IF v_status NOT IN ('draft','approved','discarded','archived','open') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_tx := app.puuid(f, 'transaction_id');
  v_limit := coalesce(app.pnum(f, 'limit', 200), 50);
  IF v_limit < 1 OR v_limit <> trunc(v_limit) THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  RETURN coalesce((SELECT jsonb_agg(app.doc_batch_json(b, false) ORDER BY b.updated_at DESC, b.id)
    FROM (SELECT x.* FROM public.doc_batches x
           WHERE x.org_id = p_org AND app.doc_batch_visible(x.org_id, x.branch_id)
             AND (CASE WHEN v_status = 'open' THEN x.status IN ('draft','discarded') ELSE x.status = v_status END)
             AND (v_tx IS NULL OR x.transaction_id = v_tx)
           ORDER BY x.updated_at DESC, x.id LIMIT v_limit::int) b), '[]'::jsonb);
END $$;

-- discard_doc_batch(p_batch, p_reason) — draft → discarded (nothing transferred; the readings stay); reason required
CREATE OR REPLACE FUNCTION public.discard_doc_batch(p_batch uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.doc_batches;
  v_why text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
BEGIN
  b := app.doc_batch_lock(p_batch, true);
  IF v_why IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_why) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.doc_batches x SET status = 'discarded', closed_at = now(), closed_by = auth.uid(), close_reason = v_why,
         updated_by = auth.uid(), updated_at = now()
   WHERE x.id = b.id RETURNING * INTO b;
  RETURN app.doc_batch_json(b, false);
END $$;

-- archive_doc_batch(p_batch, p_reason) — draft / discarded → archived (off the pending list; never deleted). An approved
-- batch (linked to its transaction) cannot be archived: MRS_DOC_BATCH_STATE approved.
CREATE OR REPLACE FUNCTION public.archive_doc_batch(p_batch uuid, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.doc_batches;
  v_why text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
BEGIN
  b := app.doc_batch_lock(p_batch, false);
  IF b.status NOT IN ('draft','discarded') THEN PERFORM app.fail('MRS_DOC_BATCH_STATE', b.status); END IF;
  IF char_length(v_why) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.doc_batches x SET status = 'archived', closed_at = now(), closed_by = auth.uid(),
         close_reason = coalesce(v_why, x.close_reason, 'أرشفة'), updated_by = auth.uid(), updated_at = now()
   WHERE x.id = b.id RETURNING * INTO b;
  RETURN app.doc_batch_json(b, false);
END $$;

-- approve_doc_batch(p_batch, {version, transaction_id? | new_transaction? {client_id, operation?, mode?}, shipping_agent_id?,
-- confirm_client?, idempotencyKey?}) — a STAFF member (ops writer on the branch) approves the saved draft. One atomic
-- step (legacy saveReviewedDocumentData): the target transaction (the batch's / transaction_id, or a new one from the draft
-- with the chosen client — the importer chosen on the form is kept, never replaced by the reading); empty transaction
-- columns filled from the draft (a differing value is kept and reported); the port inferred from the port of discharge only
-- when it names an approved port; the B/L through save_bl (vessel, voyage, ports, goods, packages, gross weight, carrier,
-- shipping agent); containers inserted through the step-2 duplicate guard (MRS_DUPLICATE_TX container rolls everything
-- back, the draft stays) or completed (empty seal / size / weight only); transaction_shipment_data written; the previous
-- invoice / packing items voided and the new ones inserted; the readings linked to the transaction and marked reviewed;
-- the client alias learned (approved with confirm_client, else suggested). → {batch_id, status, transaction_id, ref, …}
CREATE OR REPLACE FUNCTION public.approve_doc_batch(p_batch uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  b public.doc_batches; p jsonb := coalesce(p_payload, '{}'::jsonb); v_key uuid; v_replay jsonb; v_ver jsonb;
  v_tx public.transactions; v_new jsonb; v_created boolean := false; v_client uuid; v_d jsonb; s jsonb; iv jsonb; pk jsonb;
  v_cmp jsonb; v_bl text; v_pod text; v_port text; v_filled text[] := '{}'; v_kept text[] := '{}'; v_blres jsonb := NULL;
  v_bl_id uuid; v_primary boolean; c jsonb; v_cid uuid; v_cur public.containers; v_added text[] := '{}'; v_upd text[] := '{}';
  v_same text[] := '{}'; v_n_inv int := 0; v_n_pack int := 0; v_n_ext int := 0; v_alias jsonb := NULL; v_agent uuid;
  v_name text; v_res jsonb; x record; v_op text; v_mode text; v_goods text; v_pkgs numeric; v_country text; v_line text;
  v_top jsonb; ts jsonb; tiv jsonb; tpk jsonb; v_prev public.transaction_shipment_data; v_merged jsonb := NULL;
  v_inv_new boolean; v_pack_new boolean; v_name_all text;
BEGIN
  b := app.doc_batch_lock(p_batch, false);
  PERFORM app.only_keys(p, ARRAY['version','transaction_id','new_transaction','shipping_agent_id','confirm_client','idempotencyKey']);
  v_key := app.idem_key_from(p);
  -- REVIEW: the batch is part of the hashed request: a key reused for another batch is a conflict, never a replay
  v_replay := app.idem_begin('approve_doc_batch', v_key, jsonb_build_object('batch', b.id, 'p', p - 'idempotencyKey'), b.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF b.status <> 'draft' THEN PERFORM app.fail('MRS_DOC_BATCH_STATE', b.status); END IF;
  v_ver := p -> 'version';
  IF v_ver IS NULL OR jsonb_typeof(v_ver) <> 'number' THEN PERFORM app.fail('MRS_REQUIRED', 'version'); END IF;
  IF (v_ver #>> '{}')::numeric <> b.version THEN PERFORM app.fail('MRS_DOC_BATCH_STALE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.doc_batch_documents d WHERE d.batch_id = b.id AND d.detached_at IS NULL) THEN
    PERFORM app.fail('MRS_REQUIRED', 'documents');
  END IF;
  IF EXISTS (SELECT 1 FROM public.doc_batch_documents d JOIN public.document_extractions e ON e.id = d.extraction_id
              WHERE d.batch_id = b.id AND d.detached_at IS NULL AND e.voided_at IS NOT NULL) THEN
    PERFORM app.fail('MRS_MATCH_DOC_VOIDED', 'extraction');
  END IF;
  v_top := b.draft;
  IF app.doc_batch_draft_check(v_top) IS NOT NULL OR v_top = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'draft'); END IF;
  ts := coalesce(nullif(v_top -> 'shipment', 'null'), '{}'::jsonb);
  tiv := coalesce(nullif(v_top -> 'invoice', 'null'), '{}'::jsonb);
  tpk := coalesce(nullif(v_top -> 'packing', 'null'), '{}'::jsonb);
  -- the alias is learned from THIS batch's documents only
  v_name := coalesce(app.doc_val(ts -> 'consignee_name'), app.consignee_identity_name(ts ->> 'consignee'), app.consignee_identity_name(tiv ->> 'buyer'));

  -- the target transaction
  IF app.puuid(p, 'transaction_id') IS NOT NULL AND p ? 'new_transaction' THEN PERFORM app.fail('MRS_INVALID', 'new_transaction'); END IF;
  IF b.transaction_id IS NOT NULL AND app.puuid(p, 'transaction_id') IS DISTINCT FROM b.transaction_id
     AND (app.puuid(p, 'transaction_id') IS NOT NULL OR p ? 'new_transaction') THEN
    PERFORM app.fail('MRS_INVALID', 'transaction_id');
  END IF;
  IF coalesce(b.transaction_id, app.puuid(p, 'transaction_id')) IS NOT NULL THEN
    v_tx := app.g3_lock_tx(coalesce(b.transaction_id, app.puuid(p, 'transaction_id')), app.ops_writer_roles());
    IF v_tx.org_id <> b.org_id THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
    IF v_tx.branch_id <> b.branch_id THEN
      IF b.transaction_id IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'branch'); END IF;
      UPDATE public.doc_batches y SET branch_id = v_tx.branch_id WHERE y.id = b.id RETURNING * INTO b;
    END IF;
  ELSE
    v_new := p -> 'new_transaction';
    IF v_new IS NULL OR jsonb_typeof(v_new) <> 'object' THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
    PERFORM app.only_keys(v_new, ARRAY['client_id','operation','mode']);
    v_client := coalesce(app.puuid(v_new, 'client_id'), b.client_id);
    IF v_client IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.clients c2 WHERE c2.id = v_client AND c2.org_id = b.org_id AND c2.is_active) THEN
      PERFORM app.fail('MRS_NOT_FOUND', 'client');
    END IF;
    v_op := coalesce(app.ptext(v_new, 'operation', 10), 'import');
    v_mode := coalesce(app.ptext(v_new, 'mode', 10), 'sea');
    IF v_op NOT IN ('import','export') THEN PERFORM app.fail('MRS_INVALID', 'operation'); END IF;
    IF v_mode NOT IN ('sea','air','land') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
    INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, created_by)
    VALUES (b.org_id, b.branch_id, v_client, v_op, v_mode, auth.uid())
    RETURNING * INTO v_tx;
    v_created := true;
  END IF;
  v_client := v_tx.client_id;

  -- REVIEW: a transaction approved before keeps its data (legacy getDocumentWorkspace + mergeDocumentDrafts_): this batch's
  -- draft is laid over the approved one — a non-empty value of this batch wins, containers merge by number, an item list
  -- replaces the earlier one only when this batch has items; everything below works on the combined draft
  SELECT * INTO v_prev FROM public.transaction_shipment_data t WHERE t.transaction_id = v_tx.id FOR UPDATE;
  v_d := CASE WHEN v_prev.transaction_id IS NOT NULL AND v_prev.draft IS NOT NULL THEN app.doc_draft_overlay(v_prev.draft, v_top) ELSE v_top END;
  s := coalesce(nullif(v_d -> 'shipment', 'null'), '{}'::jsonb);
  iv := coalesce(nullif(v_d -> 'invoice', 'null'), '{}'::jsonb);
  pk := coalesce(nullif(v_d -> 'packing', 'null'), '{}'::jsonb);
  v_inv_new := jsonb_array_length(coalesce(nullif(tiv -> 'items', 'null'), '[]')) > 0;
  v_pack_new := jsonb_array_length(coalesce(nullif(tpk -> 'items', 'null'), '[]')) > 0;
  IF v_prev.transaction_id IS NOT NULL THEN
    v_merged := jsonb_build_object('batch_id', v_prev.batch_id, 'draft_merged', v_prev.draft IS NOT NULL,
      'invoice_items_kept', NOT v_inv_new, 'packing_items_kept', NOT v_pack_new);
  END IF;
  v_cmp := app.doc_batch_compare(v_d);
  v_name_all := coalesce(app.doc_val(s -> 'consignee_name'), app.consignee_identity_name(s ->> 'consignee'), app.consignee_identity_name(iv ->> 'buyer'));
  -- legacy normalizeValidBillNo_: a placeholder (N/A, NONE, 0…) is no B/L number
  v_bl := coalesce(app.doc_bl_no(app.doc_val(s -> 'bl_number')), app.doc_bl_no(app.doc_val(iv -> 'bl_number')), app.doc_bl_no(app.doc_val(pk -> 'bl_number')));
  IF char_length(v_bl) > 40 THEN PERFORM app.fail('MRS_TOO_LONG', 'bl_number'); END IF;

  -- empty transaction columns ← the draft (an existing value is never replaced; a differing one is reported)
  v_goods := left(coalesce(app.doc_val(s -> 'goods_description'), app.doc_val(v_d #> '{invoice,items,0,description}')), 1000);
  v_pkgs := coalesce(app.doc_num(s -> 'packages_count'), app.doc_num(pk -> 'total_packages'));
  v_country := left(app.doc_val(iv -> 'country_of_origin'), 80);
  v_pod := coalesce(app.doc_val(s -> 'port_of_discharge'), app.doc_val(iv -> 'port_of_discharge'), app.doc_val(pk -> 'port_of_discharge'));
  -- the port: only an approved port named by the port of discharge (legacy: «The port is inferred from POD only when approved»)
  SELECT cp.code INTO v_port FROM public.customs_ports cp
   WHERE cp.is_active AND v_pod IS NOT NULL AND (v_tx.mode = 'air') = (cp.kind = 'air')
     AND (app.legacy_search_key(v_pod) LIKE '%' || app.legacy_search_key(cp.name_en) || '%'
          OR app.legacy_search_key(v_pod) LIKE '%' || app.legacy_search_key(cp.name_ar) || '%'
          OR app.legacy_search_key(cp.name_en) LIKE app.legacy_search_key(v_pod) || '%'
          OR upper(btrim(v_pod)) = cp.unlocode)
   ORDER BY cp.sort LIMIT 1;
  FOR x IN SELECT * FROM (VALUES
      ('port_of_loading', left(coalesce(app.doc_val(s -> 'port_of_loading'), app.doc_val(iv -> 'port_of_loading'), app.doc_val(pk -> 'port_of_loading')), 80), to_jsonb(v_tx.port_of_loading)),
      ('port_of_discharge', left(v_pod, 80), to_jsonb(v_tx.port_of_discharge)),
      ('goods_description', v_goods, to_jsonb(v_tx.goods_description)),
      ('country', v_country, to_jsonb(v_tx.country)),
      ('shipping_line', left(app.doc_val(s -> 'shipping_line'), 80), to_jsonb(v_tx.shipping_line)),
      ('package_count', CASE WHEN v_pkgs = trunc(v_pkgs) AND v_pkgs <= 2000000000 THEN trunc(v_pkgs)::text END, to_jsonb(v_tx.package_count)),
      ('port_code', v_port, to_jsonb(v_tx.port_code))) AS t(col, val, cur) LOOP
    CONTINUE WHEN x.val IS NULL;
    IF x.cur IS NULL OR jsonb_typeof(x.cur) = 'null' THEN
      v_filled := v_filled || x.col;
    ELSIF app.legacy_search_key(x.cur #>> '{}') IS DISTINCT FROM app.legacy_search_key(x.val) THEN
      v_kept := v_kept || x.col;
    END IF;
  END LOOP;
  IF cardinality(v_filled) > 0 THEN
    UPDATE public.transactions t SET
      port_of_loading = CASE WHEN 'port_of_loading' = ANY (v_filled) THEN left(coalesce(app.doc_val(s -> 'port_of_loading'), app.doc_val(iv -> 'port_of_loading'), app.doc_val(pk -> 'port_of_loading')), 80) ELSE t.port_of_loading END,
      port_of_discharge = CASE WHEN 'port_of_discharge' = ANY (v_filled) THEN left(v_pod, 80) ELSE t.port_of_discharge END,
      goods_description = CASE WHEN 'goods_description' = ANY (v_filled) THEN v_goods ELSE t.goods_description END,
      country = CASE WHEN 'country' = ANY (v_filled) THEN v_country ELSE t.country END,
      shipping_line = CASE WHEN 'shipping_line' = ANY (v_filled) THEN left(app.doc_val(s -> 'shipping_line'), 80) ELSE t.shipping_line END,
      package_count = CASE WHEN 'package_count' = ANY (v_filled) THEN trunc(v_pkgs)::int ELSE t.package_count END,
      port_code = CASE WHEN 'port_code' = ANY (v_filled) THEN v_port ELSE t.port_code END
     WHERE t.id = v_tx.id RETURNING * INTO v_tx;
  END IF;

  -- B/L (G3 save_bl: an existing B/L of the org is linked, never duplicated) + the shipping agent
  v_agent := app.puuid(p, 'shipping_agent_id');
  IF v_agent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id = v_agent AND pa.org_id = b.org_id
                                            AND 'shipping_agent' = ANY (pa.kinds)) THEN
    PERFORM app.fail('MRS_INVALID', 'shipping_agent_id');
  END IF;
  IF v_bl IS NOT NULL THEN
    v_primary := NOT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id AND tb.is_primary);
    v_blres := public.save_bl(jsonb_strip_nulls(jsonb_build_object('transaction_id', v_tx.id, 'bl_number', v_bl,
      'primary', v_primary, 'vessel', left(coalesce(app.doc_val(s -> 'vessel'), app.doc_val(iv -> 'vessel')), 80),
      'voyage', left(coalesce(app.doc_val(s -> 'voyage'), app.doc_val(iv -> 'voyage')), 40),
      'port_of_loading', left(coalesce(app.doc_val(s -> 'port_of_loading'), app.doc_val(iv -> 'port_of_loading')), 80),
      'port_of_discharge', left(v_pod, 80), 'goods_description', left(app.doc_val(s -> 'goods_description'), 1000),
      'packages', CASE WHEN app.doc_num(s -> 'packages_count') = trunc(app.doc_num(s -> 'packages_count')) THEN trunc(app.doc_num(s -> 'packages_count'))::text END,
      'gross_weight_kg', CASE WHEN app.doc_num(s -> 'gross_weight') >= 0 THEN app.doc_num(s -> 'gross_weight')::text END,
      'carrier_name', left(app.doc_val(s -> 'shipping_line'), 120), 'shipping_agent_id', v_agent,
      'origin_country', v_country)), NULL);
    v_bl_id := (v_blres ->> 'id')::uuid;
    IF v_agent IS NOT NULL AND (v_blres ->> 'existing')::boolean THEN
      UPDATE public.bills_of_lading bl SET shipping_agent_id = v_agent WHERE bl.id = v_bl_id AND bl.shipping_agent_id IS NULL;
    END IF;
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
  END IF;

  -- containers (step-2 duplicate guard fires on insert: MRS_DUPLICATE_TX container rolls the whole approval back)
  IF jsonb_array_length(coalesce(nullif(ts -> 'containers', 'null'), '[]')) > 0 AND v_tx.cargo_unit_type = 'roro' THEN
    PERFORM app.fail('MRS_INVALID', 'containers_roro');
  END IF;
  FOR c IN SELECT y FROM jsonb_array_elements(coalesce(nullif(ts -> 'containers', 'null'), '[]')) y LOOP
    SELECT * INTO v_cur FROM public.containers k WHERE k.transaction_id = v_tx.id AND k.container_no = c ->> 'container_number' FOR UPDATE;
    IF v_cur.id IS NULL THEN
      INSERT INTO public.containers (org_id, transaction_id, container_no, seal_no, size_type, gross_weight_kg, bl_id)
      VALUES (v_tx.org_id, v_tx.id, c ->> 'container_number', nullif(c ->> 'seal_number', ''), nullif(c ->> 'size_type', ''),
              app.doc_num(c -> 'gross_weight'),
              CASE WHEN v_bl_id IS NOT NULL AND NOT coalesce((v_blres ->> 'is_primary')::boolean, false)
                        AND EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id AND tb.bl_id = v_bl_id)
                   THEN v_bl_id END);
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

  -- the «بيانات فسح» record (one per transaction; a later approval replaces it)
  INSERT INTO public.transaction_shipment_data AS t (transaction_id, org_id, batch_id, shipper, consignee, consignee_name, notify_party,
    booking_number, bl_number, vessel, voyage, port_of_loading, port_of_discharge, place_of_receipt, place_of_delivery,
    goods_description, packages_count, package_type, net_weight_kg, gross_weight_kg, measurement_cbm, temperature_c,
    freight_terms, shipping_line, invoice_number, invoice_date, seller, buyer, currency, country_of_origin, export_country,
    total_value, incoterms, payment_terms, packing_list_number, packing_list_date, packing_total_packages, packing_package_type,
    packing_net_weight_kg, packing_gross_weight_kg, containers, matches, conflicts, missing_fields, source_notes, draft, approved_by,
    approved_at, updated_at)
  VALUES (v_tx.id, v_tx.org_id, b.id, left(app.doc_val(s -> 'shipper'), 2000), left(app.doc_val(s -> 'consignee'), 2000),
    left(v_name_all, 160), left(app.doc_val(s -> 'notify_party'), 2000), left(app.doc_val(s -> 'booking_number'), 120), v_bl,
    left(coalesce(app.doc_val(s -> 'vessel'), app.doc_val(iv -> 'vessel'), app.doc_val(pk -> 'vessel')), 160),
    left(coalesce(app.doc_val(s -> 'voyage'), app.doc_val(iv -> 'voyage'), app.doc_val(pk -> 'voyage')), 80),
    left(coalesce(app.doc_val(s -> 'port_of_loading'), app.doc_val(iv -> 'port_of_loading'), app.doc_val(pk -> 'port_of_loading')), 160),
    left(v_pod, 160), left(app.doc_val(s -> 'place_of_receipt'), 160), left(app.doc_val(s -> 'place_of_delivery'), 160),
    left(app.doc_val(s -> 'goods_description'), 2000), app.doc_num(s -> 'packages_count'), left(app.doc_val(s -> 'package_type'), 80),
    app.doc_num(s -> 'net_weight'), app.doc_num(s -> 'gross_weight'), app.doc_num(s -> 'measurement_cbm'), app.doc_num(s -> 'temperature_c'),
    left(app.doc_val(s -> 'freight_terms'), 120), left(app.doc_val(s -> 'shipping_line'), 160),
    left(app.doc_val(iv -> 'invoice_number'), 120), app.pdate(iv, 'invoice_date'), left(app.doc_val(iv -> 'seller'), 2000),
    left(app.doc_val(iv -> 'buyer'), 2000), left(upper(app.doc_val(iv -> 'currency')), 10), left(app.doc_val(iv -> 'country_of_origin'), 120),
    left(app.doc_val(iv -> 'export_country'), 120), app.doc_num(iv -> 'total'), left(app.doc_val(iv -> 'incoterms'), 120),
    left(app.doc_val(iv -> 'payment_terms'), 120), left(app.doc_val(pk -> 'packing_list_number'), 120), app.pdate(pk, 'packing_list_date'),
    app.doc_num(pk -> 'total_packages'), left(app.doc_val(pk -> 'package_type'), 80), app.doc_num(pk -> 'total_net_weight'),
    app.doc_num(pk -> 'total_gross_weight'), coalesce(nullif(s -> 'containers', 'null'), '[]'), v_cmp -> 'matches', v_cmp -> 'conflicts',
    v_cmp -> 'missing_fields', coalesce(nullif(v_d -> 'source_notes', 'null'), '[]'), v_d, auth.uid(), now(), now())
  ON CONFLICT (transaction_id) DO UPDATE SET
    batch_id = EXCLUDED.batch_id, shipper = EXCLUDED.shipper, consignee = EXCLUDED.consignee, consignee_name = EXCLUDED.consignee_name,
    notify_party = EXCLUDED.notify_party, booking_number = EXCLUDED.booking_number, bl_number = EXCLUDED.bl_number,
    vessel = EXCLUDED.vessel, voyage = EXCLUDED.voyage, port_of_loading = EXCLUDED.port_of_loading,
    port_of_discharge = EXCLUDED.port_of_discharge, place_of_receipt = EXCLUDED.place_of_receipt,
    place_of_delivery = EXCLUDED.place_of_delivery, goods_description = EXCLUDED.goods_description,
    packages_count = EXCLUDED.packages_count, package_type = EXCLUDED.package_type, net_weight_kg = EXCLUDED.net_weight_kg,
    gross_weight_kg = EXCLUDED.gross_weight_kg, measurement_cbm = EXCLUDED.measurement_cbm, temperature_c = EXCLUDED.temperature_c,
    freight_terms = EXCLUDED.freight_terms, shipping_line = EXCLUDED.shipping_line, invoice_number = EXCLUDED.invoice_number,
    invoice_date = EXCLUDED.invoice_date, seller = EXCLUDED.seller, buyer = EXCLUDED.buyer, currency = EXCLUDED.currency,
    country_of_origin = EXCLUDED.country_of_origin, export_country = EXCLUDED.export_country, total_value = EXCLUDED.total_value,
    incoterms = EXCLUDED.incoterms, payment_terms = EXCLUDED.payment_terms, packing_list_number = EXCLUDED.packing_list_number,
    packing_list_date = EXCLUDED.packing_list_date, packing_total_packages = EXCLUDED.packing_total_packages,
    packing_package_type = EXCLUDED.packing_package_type, packing_net_weight_kg = EXCLUDED.packing_net_weight_kg,
    packing_gross_weight_kg = EXCLUDED.packing_gross_weight_kg, containers = EXCLUDED.containers, matches = EXCLUDED.matches,
    conflicts = EXCLUDED.conflicts, missing_fields = EXCLUDED.missing_fields, source_notes = EXCLUDED.source_notes,
    draft = EXCLUDED.draft, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, updated_at = now();

  -- items: a list of this batch replaces the previous approval's lines (voided, void-only); without one they are kept
  v_line := 'استُبدلت باعتماد حزمة المستندات ' || b.id::text;
  IF v_inv_new THEN
  UPDATE public.shipment_invoice_items i SET voided_at = now(), voided_by = auth.uid(), void_reason = v_line
   WHERE i.transaction_id = v_tx.id AND i.voided_at IS NULL;
  INSERT INTO public.shipment_invoice_items (org_id, transaction_id, batch_id, line_no, invoice_number, description, scientific_name,
    supplier_hs_code, quantity, unit, unit_price, total, origin_country, net_weight_kg, gross_weight_kg, notes, created_by)
  SELECT v_tx.org_id, v_tx.id, b.id, o::int, left(app.doc_val(it -> 'invoice_number'), 120), left(app.doc_val(it -> 'description'), 2000),
         left(app.doc_val(it -> 'scientific_name'), 300), left(app.doc_val(it -> 'supplier_hs_code'), 40), app.doc_num(it -> 'quantity'),
         left(app.doc_val(it -> 'unit'), 40), app.doc_num(it -> 'unit_price'), app.doc_num(it -> 'total'),
         left(app.doc_val(it -> 'origin_country'), 120), app.doc_num(it -> 'net_weight'), app.doc_num(it -> 'gross_weight'),
         left(app.doc_val(it -> 'notes'), 500), auth.uid()
    FROM jsonb_array_elements(coalesce(nullif(tiv -> 'items', 'null'), '[]')) WITH ORDINALITY AS u(it, o);
  GET DIAGNOSTICS v_n_inv = ROW_COUNT;
  END IF;
  IF v_pack_new THEN
  UPDATE public.shipment_packing_items i SET voided_at = now(), voided_by = auth.uid(), void_reason = v_line
   WHERE i.transaction_id = v_tx.id AND i.voided_at IS NULL;
  INSERT INTO public.shipment_packing_items (org_id, transaction_id, batch_id, line_no, packing_list_number, description, packages,
    quantity, unit, net_weight_kg, gross_weight_kg, container_no, seal_no, notes, created_by)
  SELECT v_tx.org_id, v_tx.id, b.id, o::int, left(app.doc_val(it -> 'packing_list_number'), 120), left(app.doc_val(it -> 'description'), 2000),
         app.doc_num(it -> 'packages'), app.doc_num(it -> 'quantity'), left(app.doc_val(it -> 'unit'), 40), app.doc_num(it -> 'net_weight'),
         app.doc_num(it -> 'gross_weight'), left(app.norm_code(app.doc_val(it -> 'container_number')), 20),
         left(app.doc_val(it -> 'seal_number'), 30), left(app.doc_val(it -> 'notes'), 500), auth.uid()
    FROM jsonb_array_elements(coalesce(nullif(tpk -> 'items', 'null'), '[]')) WITH ORDINALITY AS u(it, o);
  GET DIAGNOSTICS v_n_pack = ROW_COUNT;
  END IF;

  -- the readings: linked to the transaction (set once) and marked reviewed by the approver
  FOR x IN SELECT e.id, e.transaction_id FROM public.doc_batch_documents d JOIN public.document_extractions e ON e.id = d.extraction_id
            WHERE d.batch_id = b.id AND d.detached_at IS NULL FOR UPDATE OF e LOOP
    IF x.transaction_id IS NOT NULL AND x.transaction_id <> v_tx.id THEN PERFORM app.fail('MRS_INVALID', 'transaction_id'); END IF;
    BEGIN
      UPDATE public.document_extractions e SET transaction_id = v_tx.id,
             review_status = CASE WHEN e.review_status = 'unreviewed' THEN 'reviewed' ELSE e.review_status END
       WHERE e.id = x.id;
    EXCEPTION WHEN unique_violation THEN
      PERFORM app.fail('MRS_EXTRACTION_DUPLICATE');
    END;
    v_n_ext := v_n_ext + 1;
  END LOOP;

  -- the client alias (legacy: approved only on a staff confirmation; otherwise only suggested)
  IF v_name IS NOT NULL THEN
    v_alias := app.client_alias_learn(b.org_id, v_client, v_name, CASE WHEN app.pbool(p, 'confirm_client') THEN 'approved' ELSE 'suggested' END,
                                      'bl', coalesce(v_bl, b.id::text), NULL);
  END IF;

  v_res := jsonb_build_object(
    'batch_id', b.id, 'status', 'approved', 'transaction_id', v_tx.id, 'ref', v_tx.ref, 'created_transaction', v_created,
    'client_id', v_client, 'bl', CASE WHEN v_blres IS NULL THEN NULL ELSE jsonb_build_object('id', v_bl_id, 'bl_number', v_bl,
      'created', (v_blres ->> 'created')::boolean, 'existing', (v_blres ->> 'existing')::boolean, 'is_primary', (v_blres ->> 'is_primary')::boolean) END,
    'containers', jsonb_build_object('added', to_jsonb(v_added), 'updated', to_jsonb(v_upd), 'unchanged', to_jsonb(v_same)),
    'invoice_items', v_n_inv, 'packing_items', v_n_pack, 'extractions_linked', v_n_ext,
    'tx_filled', to_jsonb(v_filled), 'tx_kept', to_jsonb(v_kept), 'port_code', v_tx.port_code,
    'client_alias', v_alias, 'conflicts', v_cmp -> 'conflicts', 'missing_fields', v_cmp -> 'missing_fields',
    'merged_previous', v_merged);
  UPDATE public.doc_batches y SET status = 'approved', transaction_id = v_tx.id, client_id = v_client, comparison = v_cmp,
         approved_by = auth.uid(), approved_at = now(), approve_result = v_res, created_transaction = v_created,
         version = y.version + 1, updated_by = auth.uid(), updated_at = now()
   WHERE y.id = b.id;
  PERFORM app.idem_finish('approve_doc_batch', v_key, v_res);
  RETURN v_res;
END $$;

-- get_transaction_shipment(p_tx) — staff of the transaction's branch → {shipment_data | null, invoice_items: [live],
-- packing_items: [live], batches: [{id, status, approved_at, …}]}
CREATE OR REPLACE FUNCTION public.get_transaction_shipment(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NULL OR NOT app.has_tx_role(p_tx, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  RETURN jsonb_build_object(
    'transaction_id', p_tx,
    'shipment_data', (SELECT to_jsonb(s) FROM public.transaction_shipment_data s WHERE s.transaction_id = p_tx),
    'invoice_items', coalesce((SELECT jsonb_agg(to_jsonb(i) - ARRAY['voided_at','voided_by','void_reason'] ORDER BY i.line_no)
                                 FROM public.shipment_invoice_items i WHERE i.transaction_id = p_tx AND i.voided_at IS NULL), '[]'::jsonb),
    'packing_items', coalesce((SELECT jsonb_agg(to_jsonb(i) - ARRAY['voided_at','voided_by','void_reason'] ORDER BY i.line_no)
                                 FROM public.shipment_packing_items i WHERE i.transaction_id = p_tx AND i.voided_at IS NULL), '[]'::jsonb),
    'batches', coalesce((SELECT jsonb_agg(app.doc_batch_json(b, false) ORDER BY b.created_at DESC)
                           FROM public.doc_batches b WHERE b.transaction_id = p_tx AND app.doc_batch_visible(b.org_id, b.branch_id)), '[]'::jsonb));
END $$;

-- match_client_v2(p_org, {name, vat_number?, cr_number?, limit?}) — staff; the legacy cascade (resolveCustomerMatchForDraft_)
-- on the consignee identity name: exact official English name (two clients with it = conflict, no suggestion) → approved
-- alias → exact Arabic name → VAT / CR → name similarity. confidence 0–100; suggested only at ≥ 90 with a 10-point lead
-- and no conflict; candidates ≥ 70 are «review». NEVER links or confirms anything (confirm_client_match does, on a staff
-- click). Rejected aliases are never used; suggested aliases only add to the similarity. Inactive clients are excluded.
-- → {source_name, latin_key, candidates: [{client_id, name_ar, name_en, confidence, method, review, reasons}], best |
--    null, suggested, conflict, thresholds: {suggest: 90, review: 70}}
CREATE OR REPLACE FUNCTION public.match_client_v2(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_src text; v_lat text; v_ar text; v_vat text; v_cr text; v_limit numeric; v_out jsonb; v_conflict boolean := false;
  v_top jsonb; v_second jsonb; v_best jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['name','vat_number','cr_number','limit']);
  v_src := app.consignee_identity_name(app.ptext(p_payload, 'name', 2000));
  v_lat := app.client_latin_key(v_src);
  v_ar := app.norm_name(v_src);
  v_vat := app.digits(app.ptext(p_payload, 'vat_number', 30));
  v_cr := app.digits(app.ptext(p_payload, 'cr_number', 30));
  v_limit := coalesce(app.pnum(p_payload, 'limit', 30), 15);
  IF v_src IS NULL AND v_vat IS NULL AND v_cr IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'name'); END IF;
  WITH sc AS (
    SELECT c.id, c.name_ar, c.name_en,
      coalesce(v_lat IS NOT NULL AND app.client_latin_key(c.name_en) = v_lat, false) AS en_hit,
      EXISTS (SELECT 1 FROM public.client_aliases a WHERE a.client_id = c.id AND a.status = 'approved'
                 AND (a.alias_norm = v_ar OR (v_lat IS NOT NULL AND app.client_latin_key(a.alias) = v_lat))) AS alias_hit,
      coalesce(v_src ~ '[؀-ۿ]' AND app.norm_name(c.name_ar) = v_ar, false) AS ar_hit,
      coalesce(v_vat IS NOT NULL AND c.vat_number = v_vat, false) AS vat_hit,
      coalesce(v_cr IS NOT NULL AND c.cr_number = v_cr, false) AS cr_hit,
      greatest(app.name_sim(v_ar, app.norm_name(c.name_ar)), app.name_sim(v_ar, app.norm_name(c.name_en)),
               app.name_sim(lower(v_lat), lower(app.client_latin_key(c.name_en))),
               coalesce((SELECT max(greatest(app.name_sim(v_ar, a.alias_norm), app.name_sim(lower(v_lat), lower(app.client_latin_key(a.alias)))))
                           FROM public.client_aliases a WHERE a.client_id = c.id AND a.status = 'approved'), 0)) AS sim,
      -- REVIEW: a SUGGESTED alias (learned without a staff confirmation) adds to the similarity but never above review
      -- (89): it can never produce a suggestion by itself
      least(0.89, coalesce((SELECT max(greatest(app.name_sim(v_ar, a.alias_norm), app.name_sim(lower(v_lat), lower(app.client_latin_key(a.alias)))))
                              FROM public.client_aliases a WHERE a.client_id = c.id AND a.status = 'suggested'), 0)) AS sim_sug,
      -- REVIEW: the legacy local scoring (transliterated Arabic name, phonetic key, Levenshtein, token coverage) for a Latin
      -- source name; without full source coverage (legacy isStrongLocalCustomerMatch_ ≥ 0.95) it stays below a suggestion
      CASE WHEN v_src ~ '[A-Za-z]' THEN app.cm_score(v_src, c.name_en, c.name_ar) END AS ph
      FROM public.clients c
     WHERE c.org_id = p_org AND c.is_active),
  sc2 AS (
    SELECT sc.*, coalesce(CASE WHEN (ph ->> 'source_coverage')::numeric >= 0.95 THEN (ph ->> 'confidence')::int
                               ELSE least(89, (ph ->> 'confidence')::int) END, 0) AS ph_conf
      FROM sc),
  m AS (
    SELECT sc2.*,
      CASE WHEN en_hit THEN 'english_name' WHEN alias_hit THEN 'alias' WHEN ar_hit THEN 'arabic_name'
           WHEN vat_hit THEN 'vat_number' WHEN cr_hit THEN 'cr_number' WHEN sim > 0 OR sim_sug > 0 OR ph_conf > 0 THEN 'similar' END AS method,
      CASE WHEN en_hit OR alias_hit OR ar_hit OR vat_hit OR cr_hit THEN 100
           ELSE least(99, greatest(round(sim * 100), round(sim_sug * 100), ph_conf))::int END AS confidence
      FROM sc2),
  r AS (SELECT * FROM m WHERE method IS NOT NULL AND confidence >= 20 ORDER BY confidence DESC, name_ar, id LIMIT v_limit::int)
  SELECT coalesce(jsonb_agg(jsonb_build_object('client_id', r.id, 'name_ar', r.name_ar, 'name_en', r.name_en, 'confidence', r.confidence,
           'method', r.method, 'review', r.confidence >= 70 AND r.confidence < 90,
           'reasons', to_jsonb(array_remove(ARRAY[CASE WHEN r.en_hit THEN 'english_name' END, CASE WHEN r.alias_hit THEN 'alias' END,
              CASE WHEN r.ar_hit THEN 'arabic_name' END, CASE WHEN r.vat_hit THEN 'vat_number' END, CASE WHEN r.cr_hit THEN 'cr_number' END,
              CASE WHEN r.sim > 0 THEN 'similar_name' END,
              CASE WHEN r.sim_sug > 0 AND r.sim_sug > r.sim THEN 'suggested_alias' END,
              CASE WHEN r.ph_conf > round(greatest(r.sim, r.sim_sug) * 100) THEN 'phonetic_name' END], NULL)))
           ORDER BY r.confidence DESC, r.name_ar, r.id), '[]'::jsonb),
         (count(*) FILTER (WHERE r.en_hit) > 1) OR (count(*) FILTER (WHERE r.confidence = 100) > 1)
    INTO v_out, v_conflict
    FROM r;
  v_top := v_out -> 0; v_second := v_out -> 1;
  IF v_top IS NOT NULL AND NOT v_conflict AND (v_top ->> 'confidence')::int >= 90
     AND (v_second IS NULL OR (v_top ->> 'confidence')::int - (v_second ->> 'confidence')::int >= 10) THEN
    v_best := jsonb_build_object('client_id', v_top -> 'client_id', 'confidence', v_top -> 'confidence', 'method', v_top -> 'method');
  END IF;
  RETURN jsonb_build_object('source_name', v_src, 'latin_key', v_lat, 'candidates', v_out, 'best', v_best,
    'suggested', v_best IS NOT NULL, 'conflict', coalesce(v_conflict, false), 'confirmed', false,
    'thresholds', jsonb_build_object('suggest', 90, 'review', 70));
END $$;

-- confirm_client_match(p_org, {client_id, source_name, source?: bl | invoice, source_ref?, confidence?}) — ops writer; the
-- staff confirmation (legacy saveCustomerAliasFromReviewedMatch_): the identity name becomes an APPROVED alias of the
-- client (+1 occurrence, last used), the client's match statistics move; an alias of another client →
-- MRS_CLIENT_ALIAS_CONFLICT. → {client_id, alias_id, status, occurrences, created, match_count}
CREATE OR REPLACE FUNCTION public.confirm_client_match(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_client uuid; v_src text; v_conf numeric; v_res jsonb; v_source text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['client_id','source_name','source','source_ref','confidence']);
  v_client := app.puuid(p_payload, 'client_id');
  IF v_client IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client_id'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client AND c.org_id = p_org AND c.is_active) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'client');
  END IF;
  v_src := app.ptext(p_payload, 'source_name', 2000, true);
  v_source := coalesce(app.ptext(p_payload, 'source', 10), 'bl');
  IF v_source NOT IN ('bl','invoice') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
  v_conf := app.pnum(p_payload, 'confidence', 100);
  IF v_conf IS NOT NULL AND v_conf <> trunc(v_conf) THEN PERFORM app.fail('MRS_INVALID', 'confidence'); END IF;
  v_res := app.client_alias_learn(p_org, v_client, v_src, 'approved', v_source, app.ptext(p_payload, 'source_ref', 120), v_conf::int);
  RETURN v_res || jsonb_build_object('client_id', v_client,
    'match_count', (SELECT c.match_count FROM public.clients c WHERE c.id = v_client));
END $$;

-- reject_client_alias(p_alias, p_reason) — ops writer of the alias's org: the alias is never used again (status rejected)
CREATE OR REPLACE FUNCTION public.reject_client_alias(p_alias uuid, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.client_aliases;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO a FROM public.client_aliases x WHERE x.id = p_alias FOR UPDATE;
  IF a.id IS NULL OR NOT app.is_staff(a.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'alias'); END IF;
  IF NOT app.has_role(a.org_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF char_length(p_reason) > 120 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.client_aliases x SET status = 'rejected', approved_by = NULL, approved_at = NULL,
         source_ref = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), x.source_ref)
   WHERE x.id = a.id RETURNING * INTO a;
  RETURN jsonb_build_object('id', a.id, 'client_id', a.client_id, 'alias', a.alias, 'status', a.status);
END $$;

-- seed_shipping_agents(p_org) — org admin: the 15 legacy agents (idempotent, no duplicates) → {added, updated, skipped}
CREATE OR REPLACE FUNCTION public.seed_shipping_agents(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  RETURN app.seed_shipping_agents(p_org);
END $$;

-- match_shipping_agent(p_org, p_name) — staff; shipping-agent parties named by p_name (name / alias / contained alias,
-- through the legacy search key) → [{party_id, name_ar, name_en, match: name | alias | contains}]
CREATE OR REPLACE FUNCTION public.match_shipping_agent(p_org uuid, p_name text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_k text := app.legacy_search_key(left(p_name, 200));
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF v_k IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'name'); END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('party_id', x.id, 'name_ar', x.name_ar, 'name_en', x.name_en, 'match', x.m)
                                    ORDER BY x.r, x.name_ar)
    FROM (SELECT p.id, p.name_ar, p.name_en,
                 CASE WHEN app.legacy_search_key(p.name_ar) = v_k OR app.legacy_search_key(p.name_en) = v_k THEN 'name'
                      WHEN EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE app.legacy_search_key(a) = v_k) THEN 'alias'
                      ELSE 'contains' END AS m,
                 CASE WHEN app.legacy_search_key(p.name_ar) = v_k OR app.legacy_search_key(p.name_en) = v_k THEN 1
                      WHEN EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE app.legacy_search_key(a) = v_k) THEN 2 ELSE 3 END AS r
            FROM public.parties p
           WHERE p.org_id = p_org AND p.is_active AND 'shipping_agent' = ANY (p.kinds)
             AND (app.legacy_search_key(p.name_ar) = v_k OR app.legacy_search_key(p.name_en) = v_k
                  OR EXISTS (SELECT 1 FROM unnest(p.aliases || ARRAY[p.name_en]) a
                              WHERE char_length(app.legacy_search_key(a)) >= 3
                                AND (app.legacy_search_key(a) = v_k OR v_k LIKE '%' || app.legacy_search_key(a) || '%')))) x
    LIMIT 10), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------
-- 6. conversion lists (20261117000100 §10, re-created): + the 5 tables of this file (test rows, deleted) and their
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
    'public.doc_batches', 'public.doc_batch_documents', 'public.transaction_shipment_data',                -- DOCS
    'public.shipment_invoice_items', 'public.shipment_packing_items',                                      -- DOCS
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
    'public.doc_batches:trg_no_delete', 'public.doc_batch_documents:trg_no_delete',                        -- DOCS
    'public.transaction_shipment_data:trg_no_delete', 'public.shipment_invoice_items:trg_no_delete',       -- DOCS
    'public.shipment_packing_items:trg_no_delete'                                                          -- DOCS
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 7. RLS, policies, grants, function privileges
-- ---------------------------------------------------------------------
ALTER TABLE public.doc_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_batch_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_shipment_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_packing_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.doc_batches, public.doc_batch_documents, public.transaction_shipment_data, public.shipment_invoice_items,
  public.shipment_packing_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.doc_batches, public.doc_batch_documents, public.transaction_shipment_data, public.shipment_invoice_items,
  public.shipment_packing_items TO authenticated;
DROP POLICY IF EXISTS doc_batches_select ON public.doc_batches;
CREATE POLICY doc_batches_select ON public.doc_batches FOR SELECT TO authenticated USING (app.doc_batch_visible(org_id, branch_id));
DROP POLICY IF EXISTS doc_batch_documents_select ON public.doc_batch_documents;
CREATE POLICY doc_batch_documents_select ON public.doc_batch_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.doc_batches b WHERE b.id = batch_id AND app.doc_batch_visible(b.org_id, b.branch_id)));
DROP POLICY IF EXISTS transaction_shipment_data_select ON public.transaction_shipment_data;
CREATE POLICY transaction_shipment_data_select ON public.transaction_shipment_data FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
DROP POLICY IF EXISTS shipment_invoice_items_select ON public.shipment_invoice_items;
CREATE POLICY shipment_invoice_items_select ON public.shipment_invoice_items FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
DROP POLICY IF EXISTS shipment_packing_items_select ON public.shipment_packing_items;
CREATE POLICY shipment_packing_items_select ON public.shipment_packing_items FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));

-- the field / item / detail validators stay executable for the CHECK constraints (as in 20261116000100 §7)
REVOKE EXECUTE ON FUNCTION app.extraction_field_keys(), app.extraction_items_ok(jsonb), app.extraction_detail_ok(jsonb),
  app.party_aliases_ok(text[]), app.doc_batch_draft_check(jsonb), app.doc_obj_check(jsonb, text, text[], text[], text[], text[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_field_keys(), app.extraction_items_ok(jsonb), app.extraction_detail_ok(jsonb),
  app.party_aliases_ok(text[]), app.doc_batch_draft_check(jsonb), app.doc_obj_check(jsonb, text, text[], text[], text[], text[])
TO authenticated;
-- pure normalisers: signed-in users and the Edge Functions; never anon
REVOKE EXECUTE ON FUNCTION app.consignee_identity_name(text), app.client_latin_key(text), app.shipping_agents_template()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.consignee_identity_name(text), app.client_latin_key(text), app.shipping_agents_template()
TO authenticated, service_role;
-- the RLS policies run as the caller: the visibility helper (SECURITY DEFINER, read-only) is executable by authenticated
REVOKE EXECUTE ON FUNCTION app.doc_batch_visible(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.doc_batch_visible(uuid, uuid) TO authenticated;
-- internal helpers and trigger functions: SECURITY DEFINER code / triggers only
REVOKE EXECUTE ON FUNCTION app.seed_shipping_agents(uuid), app.doc_val(jsonb), app.doc_num(jsonb), app.doc_cmp_row(text, jsonb, text),
  app.doc_batch_compare(jsonb), app.doc_reading_section(public.document_extractions), app.doc_batch_merge(uuid),
  app.client_alias_learn(uuid, uuid, text, text, text, text, int), app.doc_batch_lock(uuid, boolean),
  app.doc_batch_json(public.doc_batches, boolean), app.tg_legacy_docs_no_delete(), app.tg_legacy_docs_guard(),
  app.tg_legacy_docs_audit(), app.doc_bl_no(text), app.doc_draft_overlay(jsonb, jsonb), app.cm_lev(text, text),
  app.cm_str_sim(text, text), app.cm_phonetic(text), app.cm_token_sim(text, text), app.cm_align(text[], text[]),
  app.cm_ar_tokens(text), app.cm_ar_latin(text), app.cm_score(text, text, text)
FROM PUBLIC, anon, authenticated, service_role;
-- REVIEW: the source binding — the bind RPC is service_role only (the Edge Function); the check runs in the (SECURITY
-- INVOKER) extraction trigger as the inserting staff member
REVOKE ALL ON FUNCTION public.ai_bind_source(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_bind_source(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION app.ai_usage_source_ok(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.ai_usage_source_ok(uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION app.tg_ai_usage_guard() FROM PUBLIC, anon, authenticated, service_role;
-- the guard / no-delete triggers are SECURITY INVOKER: the RPC owner runs them (no API write reaches the tables)
-- the conversion lists stay SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_delete_guards() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.create_doc_batch(uuid, jsonb), public.attach_doc_batch_document(uuid, jsonb),
  public.detach_doc_batch_document(uuid, text), public.merge_doc_batch(uuid), public.save_doc_batch_draft(uuid, jsonb),
  public.get_doc_batch(uuid), public.list_pending_doc_batches(uuid, jsonb), public.discard_doc_batch(uuid, text),
  public.archive_doc_batch(uuid, text), public.approve_doc_batch(uuid, jsonb), public.get_transaction_shipment(uuid),
  public.match_client_v2(uuid, jsonb), public.confirm_client_match(uuid, jsonb), public.reject_client_alias(uuid, text),
  public.seed_shipping_agents(uuid), public.match_shipping_agent(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_doc_batch(uuid, jsonb), public.attach_doc_batch_document(uuid, jsonb),
  public.detach_doc_batch_document(uuid, text), public.merge_doc_batch(uuid), public.save_doc_batch_draft(uuid, jsonb),
  public.get_doc_batch(uuid), public.list_pending_doc_batches(uuid, jsonb), public.discard_doc_batch(uuid, text),
  public.archive_doc_batch(uuid, text), public.approve_doc_batch(uuid, jsonb), public.get_transaction_shipment(uuid),
  public.match_client_v2(uuid, jsonb), public.confirm_client_match(uuid, jsonb), public.reject_client_alias(uuid, text),
  public.seed_shipping_agents(uuid), public.match_shipping_agent(uuid, text)
TO authenticated;
-- re-created functions (extraction_field_keys, extraction_items_ok, tg_document_extractions_before, tg_audit,
-- convert_delete_tables, convert_delete_guards): CREATE OR REPLACE keeps their existing privileges; restated above
