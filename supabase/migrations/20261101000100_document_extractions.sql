DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0100 — OCR results (التعرف الضوئي) for
-- invoices and scanned documents: document_extractions.
--
-- The browser runs the OCR (tesseract.js) and decodes the ZATCA e-invoice QR;
-- the database only stores the result. Model:
--   raw_text / extracted_fields / qr_payload = machine output, IMMUTABLE after insert
--   reviewed_fields / line_items / review_*  = what a staff member corrected/approved
-- No DELETE: a wrong row is voided (voided_at + void_reason), like documents.
-- Same bytes saved twice (same org, same transaction or none) = duplicate (23505,
-- index document_extractions_dedupe_uidx).
-- Access: staff of the org only; rows linked to a transaction additionally need a
-- staff role on that transaction's branch. Clients / visitors: no access.
-- Idempotent (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Shape validators (IMMUTABLE → usable in CHECK constraints)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban']
$$;

-- {key: string|null} with known keys only, each value <= 2000 chars
CREATE OR REPLACE FUNCTION app.extraction_fields_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) e
      WHERE NOT (e.key = ANY (app.extraction_field_keys()))
         OR jsonb_typeof(e.value) NOT IN ('string','null')
         OR char_length(e.value #>> '{}') > 2000))
$$;

-- [{description, hs_code, quantity, unit_price, amount}] — max 500 lines, scalar values only
CREATE OR REPLACE FUNCTION app.extraction_items_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_typeof(p) = 'array'
    AND jsonb_array_length(p) <= 500
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) it
      WHERE jsonb_typeof(it) <> 'object'
         OR EXISTS (SELECT 1 FROM jsonb_each(it) e
                    WHERE NOT (e.key = ANY (ARRAY['description','hs_code','quantity','unit_price','amount']))
                       OR jsonb_typeof(e.value) NOT IN ('string','number','null')
                       OR char_length(e.value #>> '{}') > 2000))
$$;

-- ---------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_extractions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  transaction_id    uuid,                                -- optional link (set once: NULL → value)
  document_id       uuid,                                -- original file, when attached to a transaction
  doc_type          text NOT NULL DEFAULT 'other',
  -- source file (the bytes themselves stay in the browser unless attached as a document)
  source_name       text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 255),
  source_sha256     text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_mime       text CHECK (char_length(source_mime) <= 120),
  source_size       bigint CHECK (source_size > 0),
  source_pages      int CHECK (source_pages BETWEEN 1 AND 200),
  -- machine output (immutable)
  engine            text NOT NULL CHECK (char_length(engine) BETWEEN 1 AND 80),      -- e.g. tesseract.js@5.1.1
  languages         text NOT NULL CHECK (char_length(languages) BETWEEN 1 AND 40),   -- e.g. ara+eng
  mean_confidence   numeric CHECK (mean_confidence BETWEEN 0 AND 100),
  raw_text          text NOT NULL CHECK (char_length(raw_text) <= 200000),
  extracted_fields  jsonb NOT NULL DEFAULT '{}'::jsonb,
  qr_payload        jsonb,                               -- decoded ZATCA QR TLV {seller_name, vat_number, timestamp, total, vat_total}
  -- human review
  reviewed_fields   jsonb,
  line_items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status     text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','reviewed','rejected')),
  review_note       text CHECK (char_length(review_note) <= 1000),
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT document_extractions_doc_type_chk CHECK (doc_type = ANY (app.document_kinds())),
  CONSTRAINT document_extractions_fields_chk CHECK (app.extraction_fields_ok(extracted_fields) AND extracted_fields IS NOT NULL),
  CONSTRAINT document_extractions_reviewed_chk CHECK (app.extraction_fields_ok(reviewed_fields)),
  CONSTRAINT document_extractions_items_chk CHECK (app.extraction_items_ok(line_items)),
  CONSTRAINT document_extractions_qr_chk CHECK (
    qr_payload IS NULL OR (jsonb_typeof(qr_payload) = 'object' AND octet_length(qr_payload::text) <= 4000)),
  CONSTRAINT document_extractions_tx_fk  FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT document_extractions_doc_fk FOREIGN KEY (document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT document_extractions_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
-- same file saved twice for the same transaction (or twice unlinked) = duplicate
CREATE UNIQUE INDEX IF NOT EXISTS document_extractions_dedupe_uidx
  ON public.document_extractions (org_id, source_sha256, coalesce(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS document_extractions_org_created_idx ON public.document_extractions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_extractions_tx_idx ON public.document_extractions (transaction_id);
CREATE INDEX IF NOT EXISTS document_extractions_doc_idx ON public.document_extractions (document_id);

-- ---------------------------------------------------------------------
-- 3. Guard trigger: server stamps, immutable machine output, set-once links
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role,
-- and the document lookup below runs under the caller's documents RLS.
-- ---------------------------------------------------------------------
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
        'reviewed_by','reviewed_at','voided_by','created_by','created_at']);
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
DROP TRIGGER IF EXISTS trg_before ON public.document_extractions;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.document_extractions
  FOR EACH ROW EXECUTE FUNCTION app.tg_document_extractions_before();

-- Audit: same trail as other tables, but WITHOUT the scanned content. audit_select
-- is org-wide for admin/supervisor (no branch check), so copying raw_text / fields
-- (VAT numbers, IBAN) would leak a branch's invoices to other branches and add up to
-- 200 KB per write. changed_fields still names every column that changed.
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
  v_old := v_old - 'tracking_token_hash';
  v_new := v_new - 'tracking_token_hash';
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) k
    WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k <> 'updated_at';
    IF v_changed IS NULL THEN RETURN NULL; END IF;   -- no-op update
  END IF;
  -- OCR content stays in document_extractions (branch-scoped RLS), never in the trail
  IF TG_TABLE_NAME = 'document_extractions' THEN
    v_old := v_old - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note'];
    v_new := v_new - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note'];
  END IF;
  v_org := CASE WHEN TG_TABLE_NAME = 'organizations' THEN (v_row ->> 'id')::uuid
                ELSE nullif(v_row ->> 'org_id', '')::uuid END;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (v_org, TG_TABLE_NAME, v_row ->> 'id', TG_OP, v_changed, v_old, v_new, auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_audit ON public.document_extractions;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.document_extractions
  FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

-- ---------------------------------------------------------------------
-- 4. RLS, policies, grants (no DELETE: void instead)
-- ---------------------------------------------------------------------
ALTER TABLE public.document_extractions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_extractions FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER, DELETE ON public.document_extractions FROM authenticated;

DROP POLICY IF EXISTS document_extractions_select ON public.document_extractions;
DROP POLICY IF EXISTS document_extractions_insert ON public.document_extractions;
DROP POLICY IF EXISTS document_extractions_update ON public.document_extractions;

CREATE POLICY document_extractions_select ON public.document_extractions FOR SELECT TO authenticated
  USING (app.is_staff(org_id)
         AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())));
CREATE POLICY document_extractions_insert ON public.document_extractions FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.is_staff(org_id)
              AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())));
CREATE POLICY document_extractions_update ON public.document_extractions FOR UPDATE TO authenticated
  USING (app.is_staff(org_id)
         AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())))
  WITH CHECK (app.is_staff(org_id)
              AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())));

-- CHECK constraints run as the caller → the pure validators must be executable
-- (0300 §7 revokes everything in app; re-granted here because this file runs after it)
REVOKE EXECUTE ON FUNCTION app.extraction_field_keys(), app.extraction_fields_ok(jsonb), app.extraction_items_ok(jsonb),
  app.tg_document_extractions_before() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_field_keys(), app.extraction_fields_ok(jsonb), app.extraction_items_ok(jsonb)
  TO authenticated;
