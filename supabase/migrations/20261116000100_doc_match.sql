-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261116000100 — document matching (مطابقة المستندات): the commercial invoice ↔ bill
-- of lading ↔ customs declaration (البيان الجمركي, optional) check of ocr.html. Builds on convert_in_place
-- (20261115000100). The comparison itself runs in the browser (assets/js/doc-match.js, engine 'match-v1') on two or
-- three readings saved as public.document_extractions; this file stores the RESULT a staff member reviewed.
--   P. preflight (convert_in_place applied, document_extractions + ai_usage_id present) + schema_versions row
--   1. field keys   app.extraction_field_keys  + gross_weight, net_weight, packages_count, package_type,
--                                                 goods_description, incoterms (prompt ai-doc-v2 of ai-extract)
--   2. table        public.document_matches: one saved match (org, optional transaction, the 2–3 extractions, mode
--                   two_way / three_way, engine_version, overall match / mismatch / review, counts, rows, reviewed rows,
--                   note, status saved → reviewed, void). No DELETE (trg_no_delete), UPDATE only through the RPCs
--                   (trg_guard: machine result immutable, a voided row frozen). Audit trail without the compared
--                   values (trg_audit = app.tg_document_matches_audit: rows / note / review_note stripped, like the OCR
--                   content of document_extractions).
--   3. helpers      app.doc_match_row_keys(), app.doc_match_statuses(), app.doc_match_rows_check(rows, mode),
--                   app.doc_match_visible(org, tx, inv, bl, decl), app.tg_document_matches_guard(),
--                   app.tg_document_matches_no_delete(), app.tg_document_matches_audit()
--   4. RLS          SELECT for staff of the org; a match linked to a transaction (or built from an extraction linked to
--                   one) needs a staff role on that transaction's branch (same rule as document_extractions). Clients
--                   (portal) and anon: nothing. No INSERT / UPDATE / DELETE grant: writes go through the RPCs.
--   5. RPCs         staff (authenticated): public.save_document_match(org, payload)        → {id, created_at, status, …}
--                                          public.review_document_match(id, reviewed_rows, note) → {id, status, reviewed_at}
--                                          public.void_document_match(id, reason)          → {id, status 'voided', voided_at}
--   6. conversion   app.convert_delete_tables() / app.convert_delete_guards() (20261115000100) re-created with
--                   public.document_matches (+ its trg_no_delete guard): convert_org_to_production deletes the org's
--                   matches in the same single statement as the extractions they point to.
--   7. privileges
-- save_document_match checks: staff of the org (app.is_staff, MFA rule of app.has_role); the transaction (optional) of the
-- org and on the caller's branches; each extraction of the org, visible to the caller, not voided, of the right kind
-- (invoice = commercial_invoice, B/L = bill_of_lading, declaration = customs_declaration), three distinct rows, linked to
-- no other transaction (a match without transaction_id adopts the extractions' transaction); mode three_way ⇔ a
-- declaration; rows: ≤ 60 objects, known keys / statuses / shapes, a declaration value only in three_way; overall
-- consistent with the rows (a critical mismatch → 'mismatch'; 'match' only without mismatch rows and without a critical
-- partial / missing row); counts ≥ 0 and not more than the rows; reviewed_rows ⊂ the row keys; note ≤ 1000. Optional
-- idempotency (payload.idempotencyKey, app.idem_begin scope save_document_match).
-- Re-runnable (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS). Re-pasting 20261101000100 or
-- 20261114000100 after this file narrows the field keys again (ai-doc-v2 readings with the new keys can then not be
-- saved): re-paste this file right after. Re-pasting 20261115000100 drops document_matches from the conversion's delete
-- list (the conversion then refuses: unclassified_tables:public.document_matches): re-paste this file right after.
-- Down-path (staging only): DROP FUNCTION public.save_document_match(uuid, jsonb), public.review_document_match(uuid,
-- jsonb, text), public.void_document_match(uuid, text) and the app.doc_match_* / app.tg_document_matches_* helpers;
-- DROP TABLE public.document_matches; re-paste 20261114000100 §2 (field keys) and 20261115000100 §1 (convert lists).
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261115000100') THEN
    RAISE EXCEPTION 'MATCH preflight: apply convert_in_place first (schema_versions lacks 20261115000100 convert_in_place)';
  END IF;
  IF to_regclass('public.document_extractions') IS NULL OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'document_extractions' AND column_name = 'ai_usage_id') THEN
    RAISE EXCEPTION 'MATCH preflight: public.document_extractions.ai_usage_id missing (apply 20261114000100 ai_documents)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261116000100', 'doc_match')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. field keys (20261114000100 §2). MATCH: + the six keys of prompt ai-doc-v2. A superset: every stored row stays
--    valid (CHECK document_extractions_fields_chk / _reviewed_chk).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban',
               'vessel','voyage','port_of_loading','port_of_discharge','shipper','consignee',
               'gross_weight','net_weight','packages_count','package_type','goods_description','incoterms']   -- MATCH
$$;

-- ---------------------------------------------------------------------
-- 2. table
-- ---------------------------------------------------------------------
-- row keys of the match engine (assets/js/doc-match.js match-v1) and the statuses of a row / a pair
CREATE OR REPLACE FUNCTION app.doc_match_row_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['invoice_number','bl_number','declaration_number','container_numbers','shipper','consignee',
               'gross_weight','net_weight','packages_count','package_type','hs_codes','country_of_origin',
               'port_of_loading','port_of_discharge','vessel','incoterms','goods_description','invoice_date',
               'currency','total','invoice_totals','items']
$$;
CREATE OR REPLACE FUNCTION app.doc_match_statuses() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['match','mismatch','partial','missing','info']
$$;

CREATE TABLE IF NOT EXISTS public.document_matches (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  transaction_id             uuid,
  invoice_extraction_id      uuid NOT NULL,
  bl_extraction_id           uuid NOT NULL,
  declaration_extraction_id  uuid,
  mode                       text NOT NULL CHECK (mode IN ('two_way','three_way')),
  engine_version             text NOT NULL CHECK (engine_version ~ '^match-v[0-9]{1,3}$'),
  overall                    text NOT NULL CHECK (overall IN ('match','mismatch','review')),
  match_count                int NOT NULL DEFAULT 0 CHECK (match_count BETWEEN 0 AND 60),
  mismatch_count             int NOT NULL DEFAULT 0 CHECK (mismatch_count BETWEEN 0 AND 60),
  partial_count              int NOT NULL DEFAULT 0 CHECK (partial_count BETWEEN 0 AND 60),
  missing_count              int NOT NULL DEFAULT 0 CHECK (missing_count BETWEEN 0 AND 60),
  rows                       jsonb NOT NULL,
  reviewed_rows              jsonb NOT NULL DEFAULT '[]'::jsonb,
  note                       text CHECK (char_length(note) <= 1000),
  status                     text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','reviewed')),
  reviewed_by                uuid,
  reviewed_at                timestamptz,
  review_note                text CHECK (char_length(review_note) <= 1000),
  created_by                 uuid NOT NULL DEFAULT auth.uid(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  voided_at                  timestamptz,
  voided_by                  uuid,
  void_reason                text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT document_matches_rows_chk CHECK (
    jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) BETWEEN 1 AND 60 AND octet_length(rows::text) <= 300000),
  CONSTRAINT document_matches_reviewed_chk CHECK (
    jsonb_typeof(reviewed_rows) = 'array' AND jsonb_array_length(reviewed_rows) <= 60),
  CONSTRAINT document_matches_mode_chk CHECK ((mode = 'three_way') = (declaration_extraction_id IS NOT NULL)),
  CONSTRAINT document_matches_distinct_chk CHECK (
    invoice_extraction_id <> bl_extraction_id
    AND declaration_extraction_id IS DISTINCT FROM invoice_extraction_id
    AND declaration_extraction_id IS DISTINCT FROM bl_extraction_id),
  CONSTRAINT document_matches_review_chk CHECK ((status = 'reviewed') = (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CONSTRAINT document_matches_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT document_matches_tx_fk   FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT document_matches_inv_fk  FOREIGN KEY (invoice_extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  CONSTRAINT document_matches_bl_fk   FOREIGN KEY (bl_extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  CONSTRAINT document_matches_decl_fk FOREIGN KEY (declaration_extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.document_matches IS 'Saved invoice ↔ B/L (↔ customs declaration) matches of ocr.html (engine assets/js/doc-match.js). Written only by public.save_document_match / review_document_match / void_document_match; no DELETE (void instead). Staff of the org only, branch-scoped through the transaction like document_extractions.';
CREATE INDEX IF NOT EXISTS document_matches_org_created_idx ON public.document_matches (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_matches_tx_idx ON public.document_matches (transaction_id);
CREATE INDEX IF NOT EXISTS document_matches_inv_idx ON public.document_matches (invoice_extraction_id);
CREATE INDEX IF NOT EXISTS document_matches_bl_idx ON public.document_matches (bl_extraction_id);
CREATE INDEX IF NOT EXISTS document_matches_decl_idx ON public.document_matches (declaration_extraction_id);

-- ---------------------------------------------------------------------
-- 3. helpers + triggers
-- ---------------------------------------------------------------------
-- rows of a match → NULL when valid, else the detail of the first problem ('rows', 'rows.key', 'rows.status', …).
-- p_mode two_way: no value / confidence / pair may name the declaration.
CREATE OR REPLACE FUNCTION app.doc_match_rows_check(p_rows jsonb, p_mode text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  r     jsonb;
  e     record;
  v_key text;
  v_seen text[] := ARRAY[]::text[];
  v_docs text[] := CASE WHEN p_mode = 'three_way' THEN ARRAY['invoice','bl','declaration'] ELSE ARRAY['invoice','bl'] END;
  v_pairs text[] := CASE WHEN p_mode = 'three_way' THEN ARRAY['inv_bl','inv_decl','bl_decl'] ELSE ARRAY['inv_bl'] END;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN RETURN 'rows'; END IF;
  IF jsonb_array_length(p_rows) > 60 OR octet_length(p_rows::text) > 300000 THEN RETURN 'rows_too_many'; END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    IF jsonb_typeof(r) <> 'object' THEN RETURN 'rows'; END IF;
    IF octet_length(r::text) > 20000 THEN RETURN 'rows.size'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE NOT (k = ANY (ARRAY['key','label_ar','label_en','values','status',
                 'detail_ar','detail_en','critical','conf','pairs','corrected']))) THEN
      RETURN 'rows.unknown_key';
    END IF;
    IF jsonb_typeof(r -> 'key') IS DISTINCT FROM 'string' OR NOT ((r ->> 'key') = ANY (app.doc_match_row_keys())) THEN
      RETURN 'rows.key';
    END IF;
    v_key := r ->> 'key';
    -- one row per field ('items' may repeat: one per line / HS code)
    IF v_key <> 'items' AND v_key = ANY (v_seen) THEN RETURN 'rows.duplicate'; END IF;
    v_seen := v_seen || v_key;
    IF jsonb_typeof(r -> 'status') IS DISTINCT FROM 'string' OR NOT ((r ->> 'status') = ANY (app.doc_match_statuses())) THEN
      RETURN 'rows.status';
    END IF;
    FOR e IN SELECT k, r -> k AS v FROM unnest(ARRAY['label_ar','label_en','detail_ar','detail_en']) k WHERE r ? k LOOP
      IF jsonb_typeof(e.v) NOT IN ('string','null') OR char_length(e.v #>> '{}') > 1000 THEN RETURN 'rows.' || e.k; END IF;
    END LOOP;
    IF r ? 'critical' AND jsonb_typeof(r -> 'critical') NOT IN ('boolean','null') THEN RETURN 'rows.critical'; END IF;
    IF r ? 'corrected' AND jsonb_typeof(r -> 'corrected') NOT IN ('boolean','null') THEN RETURN 'rows.corrected'; END IF;
    -- values: {invoice?, bl?, declaration?} → string / number / boolean / null, or an array of those (≤ 200)
    IF r ? 'values' AND jsonb_typeof(r -> 'values') <> 'null' THEN
      IF jsonb_typeof(r -> 'values') <> 'object' THEN RETURN 'rows.values'; END IF;
      FOR e IN SELECT k, v FROM jsonb_each(r -> 'values') AS j(k, v) LOOP
        IF NOT (e.k = ANY (v_docs)) THEN RETURN 'rows.values'; END IF;
        IF jsonb_typeof(e.v) = 'array' THEN
          IF jsonb_array_length(e.v) > 200 OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.v) a
                WHERE jsonb_typeof(a) NOT IN ('string','number','boolean','null') OR char_length(a #>> '{}') > 2000) THEN
            RETURN 'rows.values';
          END IF;
        ELSIF jsonb_typeof(e.v) NOT IN ('string','number','boolean','null') OR char_length(e.v #>> '{}') > 2000 THEN
          RETURN 'rows.values';
        END IF;
      END LOOP;
    END IF;
    -- conf: {invoice?, bl?, declaration?} → a number 0..1 or null
    IF r ? 'conf' AND jsonb_typeof(r -> 'conf') <> 'null' THEN
      IF jsonb_typeof(r -> 'conf') <> 'object' THEN RETURN 'rows.conf'; END IF;
      FOR e IN SELECT k, v FROM jsonb_each(r -> 'conf') AS j(k, v) LOOP
        IF NOT (e.k = ANY (v_docs)) THEN RETURN 'rows.conf'; END IF;
        IF jsonb_typeof(e.v) = 'number' THEN
          IF (e.v #>> '{}')::numeric NOT BETWEEN 0 AND 1 THEN RETURN 'rows.conf'; END IF;
        ELSIF jsonb_typeof(e.v) <> 'null' THEN RETURN 'rows.conf';
        END IF;
      END LOOP;
    END IF;
    -- pairs: {inv_bl?, inv_decl?, bl_decl?} → a status or null
    IF r ? 'pairs' AND jsonb_typeof(r -> 'pairs') <> 'null' THEN
      IF jsonb_typeof(r -> 'pairs') <> 'object' THEN RETURN 'rows.pairs'; END IF;
      FOR e IN SELECT k, v FROM jsonb_each(r -> 'pairs') AS j(k, v) LOOP
        IF NOT (e.k = ANY (v_pairs)) THEN RETURN 'rows.pairs'; END IF;
        IF jsonb_typeof(e.v) = 'string' THEN
          IF NOT ((e.v #>> '{}') = ANY (app.doc_match_statuses())) THEN RETURN 'rows.pairs'; END IF;
        ELSIF jsonb_typeof(e.v) <> 'null' THEN RETURN 'rows.pairs';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- the caller may see this match: staff of the org; the match's transaction and every linked extraction's transaction on
-- the caller's branches (an extraction linked to a transaction after the match was saved narrows the match too)
CREATE OR REPLACE FUNCTION app.doc_match_visible(p_org uuid, p_tx uuid, p_inv uuid, p_bl uuid, p_decl uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_staff(p_org)
     AND (p_tx IS NULL OR app.has_tx_role(p_tx, app.staff_roles()))
     AND NOT EXISTS (SELECT 1 FROM public.document_extractions e
                      WHERE e.id IN (p_inv, p_bl, p_decl) AND e.transaction_id IS NOT NULL
                        AND e.transaction_id IS DISTINCT FROM p_tx
                        AND NOT app.has_tx_role(e.transaction_id, app.staff_roles()))
$$;

-- machine result immutable; only the review / void columns change; a voided row is frozen
CREATE OR REPLACE FUNCTION app.tg_document_matches_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_VOIDED'); END IF;
  PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
    'id','org_id','transaction_id','invoice_extraction_id','bl_extraction_id','declaration_extraction_id','mode',
    'engine_version','overall','match_count','mismatch_count','partial_count','missing_count','rows','note',
    'created_by','created_at']);
  IF OLD.status = 'reviewed' AND NEW.status = 'saved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'status'); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.tg_document_matches_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM app.fail('MRS_APPEND_ONLY', 'document_matches');
  RETURN NULL;
END $$;

-- the trail of app.tg_audit, without the compared values (rows hold names, VAT numbers, amounts of the documents) nor
-- the free-text notes: audit_select is org-wide, the match is branch-scoped. changed_fields still names every change.
CREATE OR REPLACE FUNCTION app.tg_document_matches_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
      FROM jsonb_object_keys(v_new) k
     WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k);
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;
  v_old := v_old - ARRAY['rows','note','review_note','void_reason'];
  v_new := v_new - ARRAY['rows','note','review_note','void_reason'];
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (nullif(v_row ->> 'org_id', '')::uuid, TG_TABLE_NAME, v_row ->> 'id', TG_OP, v_changed, v_old, v_new,
          auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_guard ON public.document_matches;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.document_matches
  FOR EACH ROW EXECUTE FUNCTION app.tg_document_matches_guard();
DROP TRIGGER IF EXISTS trg_no_delete ON public.document_matches;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.document_matches
  FOR EACH ROW EXECUTE FUNCTION app.tg_document_matches_no_delete();
DROP TRIGGER IF EXISTS trg_audit ON public.document_matches;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.document_matches
  FOR EACH ROW EXECUTE FUNCTION app.tg_document_matches_audit();

-- ---------------------------------------------------------------------
-- 4. RLS, policies, grants (read only; writes through the RPCs)
-- ---------------------------------------------------------------------
ALTER TABLE public.document_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_matches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.document_matches TO authenticated;
DROP POLICY IF EXISTS document_matches_select ON public.document_matches;
CREATE POLICY document_matches_select ON public.document_matches FOR SELECT TO authenticated
  USING (app.doc_match_visible(org_id, transaction_id, invoice_extraction_id, bl_extraction_id, declaration_extraction_id));

-- ---------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------
-- save_document_match(p_org, p_payload) — staff of the org. payload = {transaction_id?, invoice_extraction_id,
-- bl_extraction_id, declaration_extraction_id?, mode, engine_version, overall, counts {match, mismatch, partial,
-- missing}, rows [...], reviewed_rows [...]?, note?, idempotencyKey?} → {id, created_at, status, transaction_id, mode,
-- overall}
CREATE OR REPLACE FUNCTION public.save_document_match(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key     uuid;
  v_replay  jsonb;
  v_tx      uuid;
  v_ids     uuid[];
  v_slots   text[] := ARRAY['invoice_extraction_id','bl_extraction_id','declaration_extraction_id'];
  v_kinds   text[] := ARRAY['commercial_invoice','bill_of_lading','customs_declaration'];
  v_i       int;
  v_id      uuid;
  e         public.document_extractions;
  v_mode    text;
  v_engine  text;
  v_overall text;
  v_rows    jsonb;
  v_bad     text;
  v_counts  jsonb;
  v_n       int[] := ARRAY[0,0,0,0];
  v_names   text[] := ARRAY['match','mismatch','partial','missing'];
  v_c       jsonb;
  v_rev     jsonb;
  v_note    text;
  v_crit_mm boolean;
  v_crit_nm boolean;
  v_any_mm  boolean;
  m         public.document_matches;
  v_res     jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','invoice_extraction_id','bl_extraction_id',
    'declaration_extraction_id','mode','engine_version','overall','counts','rows','reviewed_rows','note','idempotencyKey']);
  v_key := app.idem_key_from(p_payload);
  v_replay := app.idem_begin('save_document_match', v_key, p_payload - 'idempotencyKey', p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  -- mode / engine / overall
  v_mode := app.ptext(p_payload, 'mode', 20, true);
  IF v_mode NOT IN ('two_way','three_way') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  v_engine := app.ptext(p_payload, 'engine_version', 20, true);
  IF v_engine !~ '^match-v[0-9]{1,3}$' THEN PERFORM app.fail('MRS_INVALID', 'engine_version'); END IF;
  v_overall := app.ptext(p_payload, 'overall', 20, true);
  IF v_overall NOT IN ('match','mismatch','review') THEN PERFORM app.fail('MRS_INVALID', 'overall'); END IF;

  -- the transaction (optional): of the org, on the caller's branches
  v_tx := app.puuid(p_payload, 'transaction_id');
  IF v_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = v_tx AND t.org_id = p_org
                                         AND app.has_tx_role(t.id, app.staff_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;

  -- the extractions: invoice + B/L required, declaration ⇔ three_way
  v_ids := ARRAY[app.puuid(p_payload, 'invoice_extraction_id'), app.puuid(p_payload, 'bl_extraction_id'),
                 app.puuid(p_payload, 'declaration_extraction_id')];
  IF v_ids[1] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'invoice_extraction_id'); END IF;
  IF v_ids[2] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bl_extraction_id'); END IF;
  IF v_mode = 'three_way' AND v_ids[3] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_extraction_id'); END IF;
  IF v_mode = 'two_way' AND v_ids[3] IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  IF v_ids[1] = v_ids[2] THEN PERFORM app.fail('MRS_INVALID', 'bl_extraction_id'); END IF;
  IF v_ids[3] IN (v_ids[1], v_ids[2]) THEN PERFORM app.fail('MRS_INVALID', 'declaration_extraction_id'); END IF;
  FOR v_i IN 1..3 LOOP
    v_id := v_ids[v_i];
    CONTINUE WHEN v_id IS NULL;
    SELECT * INTO e FROM public.document_extractions x WHERE x.id = v_id AND x.org_id = p_org FOR SHARE;
    IF e.id IS NULL OR (e.transaction_id IS NOT NULL AND NOT app.has_tx_role(e.transaction_id, app.staff_roles())) THEN
      PERFORM app.fail('MRS_NOT_FOUND', v_slots[v_i]);
    END IF;
    IF e.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_DOC_VOIDED', v_slots[v_i]); END IF;
    IF e.doc_type IS DISTINCT FROM v_kinds[v_i] THEN PERFORM app.fail('MRS_MATCH_DOC_KIND', v_slots[v_i]); END IF;
    -- one transaction for the whole match: an extraction of another transaction is refused; without a transaction in
    -- the payload the match adopts the extractions' transaction (it is then branch-scoped like them)
    IF e.transaction_id IS NOT NULL THEN
      IF v_tx IS NULL THEN v_tx := e.transaction_id;
      ELSIF v_tx <> e.transaction_id THEN PERFORM app.fail('MRS_INVALID', 'transaction_id');
      END IF;
    END IF;
  END LOOP;

  -- rows
  v_rows := p_payload -> 'rows';
  v_bad := app.doc_match_rows_check(v_rows, v_mode);
  IF v_bad IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', v_bad); END IF;

  -- counts {match, mismatch, partial, missing}: whole numbers ≥ 0, together not more than the rows
  v_counts := coalesce(p_payload -> 'counts', '{}'::jsonb);
  IF jsonb_typeof(v_counts) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'counts'); END IF;
  PERFORM app.only_keys(v_counts, v_names);
  FOR v_i IN 1..4 LOOP
    v_c := v_counts -> v_names[v_i];
    IF v_c IS NULL OR jsonb_typeof(v_c) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(v_c) <> 'number' OR (v_c #>> '{}') !~ '^[0-9]{1,2}$' THEN PERFORM app.fail('MRS_INVALID', 'counts'); END IF;
    v_n[v_i] := (v_c #>> '{}')::int;
  END LOOP;
  IF v_n[1] + v_n[2] + v_n[3] + v_n[4] > jsonb_array_length(v_rows) THEN PERFORM app.fail('MRS_INVALID', 'counts'); END IF;

  -- overall must not contradict the rows (match-v1: a critical mismatch → mismatch; match only without any mismatch row
  -- and without a critical row that is partial / missing)
  SELECT bool_or(r ->> 'status' = 'mismatch' AND coalesce((r ->> 'critical')::boolean, false)),
         bool_or(r ->> 'status' IN ('partial','missing') AND coalesce((r ->> 'critical')::boolean, false)),
         bool_or(r ->> 'status' = 'mismatch')
    INTO v_crit_mm, v_crit_nm, v_any_mm
    FROM jsonb_array_elements(v_rows) r;
  IF (v_crit_mm AND v_overall <> 'mismatch') OR (v_overall = 'match' AND (v_any_mm OR v_crit_nm)) THEN
    PERFORM app.fail('MRS_INVALID', 'overall');
  END IF;

  -- reviewed rows: distinct keys of the rows
  v_rev := coalesce(p_payload -> 'reviewed_rows', '[]'::jsonb);
  IF jsonb_typeof(v_rev) = 'null' THEN v_rev := '[]'::jsonb; END IF;
  IF jsonb_typeof(v_rev) <> 'array' OR jsonb_array_length(v_rev) > 60
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_rev) k
                 WHERE jsonb_typeof(k) <> 'string'
                    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r ->> 'key' = k #>> '{}'))
     OR (SELECT count(DISTINCT k #>> '{}') FROM jsonb_array_elements(v_rev) k) <> jsonb_array_length(v_rev) THEN
    PERFORM app.fail('MRS_INVALID', 'reviewed_rows');
  END IF;
  v_note := app.ptext(p_payload, 'note', 1000);

  INSERT INTO public.document_matches (org_id, transaction_id, invoice_extraction_id, bl_extraction_id,
    declaration_extraction_id, mode, engine_version, overall, match_count, mismatch_count, partial_count, missing_count,
    rows, reviewed_rows, note, status, created_by, created_at)
  VALUES (p_org, v_tx, v_ids[1], v_ids[2], v_ids[3], v_mode, v_engine, v_overall, v_n[1], v_n[2], v_n[3], v_n[4],
    v_rows, v_rev, v_note, 'saved', auth.uid(), now())
  RETURNING * INTO m;

  v_res := jsonb_build_object('id', m.id, 'created_at', m.created_at, 'status', m.status, 'transaction_id', m.transaction_id,
                              'mode', m.mode, 'overall', m.overall);
  PERFORM app.idem_finish('save_document_match', v_key, v_res);
  RETURN v_res;
END $$;

-- review_document_match(p_id, p_reviewed_rows, p_note) — any staff member who can see the match (no four-eyes rule: an
-- org may have one member; the reviewer is recorded). Re-reviewing replaces the ticks and the note.
CREATE OR REPLACE FUNCTION public.review_document_match(p_id uuid, p_reviewed_rows jsonb, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  m      public.document_matches;
  v_rev  jsonb := coalesce(p_reviewed_rows, '[]'::jsonb);
  v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO m FROM public.document_matches x WHERE x.id = p_id FOR UPDATE;
  IF m.id IS NULL OR NOT app.doc_match_visible(m.org_id, m.transaction_id, m.invoice_extraction_id, m.bl_extraction_id,
                                                m.declaration_extraction_id) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'document_match');
  END IF;
  IF m.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_VOIDED'); END IF;
  IF jsonb_typeof(v_rev) <> 'array' OR jsonb_array_length(v_rev) > 60
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_rev) k
                 WHERE jsonb_typeof(k) <> 'string'
                    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.rows) r WHERE r ->> 'key' = k #>> '{}'))
     OR (SELECT count(DISTINCT k #>> '{}') FROM jsonb_array_elements(v_rev) k) <> jsonb_array_length(v_rev) THEN
    PERFORM app.fail('MRS_INVALID', 'reviewed_rows');
  END IF;
  IF jsonb_array_length(v_rev) = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'reviewed_rows'); END IF;
  IF char_length(v_note) > 1000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  UPDATE public.document_matches x
     SET reviewed_rows = v_rev, review_note = v_note, status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now()
   WHERE x.id = m.id
  RETURNING * INTO m;
  RETURN jsonb_build_object('id', m.id, 'status', m.status, 'reviewed_at', m.reviewed_at, 'reviewed_by', m.reviewed_by,
                            'reviewed_rows', m.reviewed_rows);
END $$;

-- void_document_match(p_id, p_reason) — any staff member who can see the match; a reason is required; once only
CREATE OR REPLACE FUNCTION public.void_document_match(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  m     public.document_matches;
  v_why text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO m FROM public.document_matches x WHERE x.id = p_id FOR UPDATE;
  IF m.id IS NULL OR NOT app.doc_match_visible(m.org_id, m.transaction_id, m.invoice_extraction_id, m.bl_extraction_id,
                                                m.declaration_extraction_id) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'document_match');
  END IF;
  IF m.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_VOIDED'); END IF;
  IF v_why IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'void_reason'); END IF;
  IF char_length(v_why) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'void_reason'); END IF;
  UPDATE public.document_matches x SET voided_at = now(), voided_by = auth.uid(), void_reason = v_why
   WHERE x.id = m.id
  RETURNING * INTO m;
  RETURN jsonb_build_object('id', m.id, 'status', 'voided', 'voided_at', m.voided_at, 'voided_by', m.voided_by);
END $$;

-- ---------------------------------------------------------------------
-- 6. conversion lists (20261115000100 §1, re-created): + public.document_matches and its delete guard
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
    'public.document_matches',                                                                          -- MATCH
    'public.parties', 'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
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
    'public.document_matches:trg_no_delete'                                                             -- MATCH
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 7. privileges
-- ---------------------------------------------------------------------
-- the field keys stay executable for the CHECK constraints (as in 20261101000100 §4 / 20261114000100 §4)
REVOKE EXECUTE ON FUNCTION app.extraction_field_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_field_keys() TO authenticated;
-- the RLS policy runs as the caller: the visibility helper (SECURITY DEFINER, read-only) is executable by authenticated
REVOKE EXECUTE ON FUNCTION app.doc_match_visible(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.doc_match_visible(uuid, uuid, uuid, uuid, uuid) TO authenticated;
-- pure validators + trigger functions: called by SECURITY DEFINER code (owner) / the triggers only
REVOKE EXECUTE ON FUNCTION app.doc_match_row_keys(), app.doc_match_statuses(), app.doc_match_rows_check(jsonb, text),
  app.tg_document_matches_guard(), app.tg_document_matches_no_delete(), app.tg_document_matches_audit()
FROM PUBLIC, anon, authenticated, service_role;
-- the conversion lists stay SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_delete_guards() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only (the Edge Functions' service_role has no use for them)
REVOKE ALL ON FUNCTION public.save_document_match(uuid, jsonb), public.review_document_match(uuid, jsonb, text),
  public.void_document_match(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_document_match(uuid, jsonb), public.review_document_match(uuid, jsonb, text),
  public.void_document_match(uuid, text) TO authenticated;
