-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261126000100 — document matching + the PACKING LIST (بيان التعبئة / قائمة التعبئة) as a
-- 4th, optional document of the ocr.html match (commercial invoice ↔ bill of lading ↔ customs declaration? ↔ packing list?),
-- like the owner's reference sheet «ورقة معلومات الإدخال في منصة فسح» (البوليصة / الفاتورة التجارية / بيان التعبئة: the
-- importer, packages, gross / net weight and goods compared across the three). Builds on doc_match (20261116000100) and the
-- legacy steps after it (20261117000100 … 20261125000100: the v3 field keys of ai-doc-v3 incl. packing_list_number /
-- packing_list_date / seal_numbers are already in app.extraction_field_keys since 20261120000100). The packing list is read
-- by ai-extract with doc_type 'packing_list' and prompt 'ai-doc-v3' and saved as a public.document_extractions row of
-- doc_type 'packing_list'; the comparison runs in the browser (assets/js/doc-match.js): engine 'match-v2' when the packing
-- list takes part (engine doc key 'packing', pairs inv_pack / bl_pack / decl_pack), 'match-v1' otherwise (unchanged).
--   P. preflight (legacy_import applied, document_matches + save_document_match present) + schema_versions row
--   1. column       public.document_matches.packing_extraction_id uuid NULL, composite FK (id, org_id) →
--                   public.document_extractions like the other three, an index, two checks: distinct from the other three
--                   ids (document_matches_pack_distinct_chk) and only on an engine 'match-v2' row
--                   (document_matches_pack_engine_chk). Every existing row stays valid (the column is NULL).
--   2. helpers      app.doc_match_rows_check(rows, mode, with_packing) (new overload: + the 'packing' value / confidence key
--                   and the pairs inv_pack, bl_pack, decl_pack (three_way only) when with_packing); the 2-argument form
--                   re-created as that check without packing (same rule as before);
--                   app.doc_match_visible(org, tx, inv, bl, decl, pack) (new overload: + the packing extraction's
--                   transaction); the 5-argument form re-created as the 6-argument one without packing;
--                   app.tg_document_matches_guard() re-created (+ packing_extraction_id immutable)
--   3. RLS          document_matches_select re-created on the 6-argument visibility helper (+ the packing extraction)
--   4. RPCs         public.save_document_match(org, payload) re-created (same arguments): + payload key
--                   'packing_extraction_id' (optional: an extraction of the org, visible to the caller, not voided, of
--                   doc_type 'packing_list', distinct from the other three, of the same transaction); engine_version
--                   'match-v1' (no packing) or 'match-v2' (packing required), any other version refused; rows checked with
--                   the packing keys when packing is given; limits (≤ 60 rows, counts, reviewed rows, note) unchanged.
--                   public.review_document_match / public.void_document_match re-created (same arguments): visibility
--                   through the packing extraction too. Results unchanged.
--   5. privileges
-- The conversion lists (convert_delete_tables / convert_delete_guards) already hold public.document_matches: unchanged.
-- No other function enumerates the document_matches columns (export / import / reports do not read them).
-- Errors: existing codes only — MRS_REQUIRED packing_extraction_id (match-v2 without packing), MRS_INVALID engine_version
-- (match-v1 with packing, or another version), MRS_INVALID packing_extraction_id (same id as another slot / malformed),
-- MRS_NOT_FOUND packing_extraction_id, MRS_MATCH_DOC_VOIDED packing_extraction_id, MRS_MATCH_DOC_KIND packing_extraction_id,
-- MRS_INVALID transaction_id, MRS_INVALID rows.values / rows.conf / rows.pairs (a packing key without the packing list).
-- Re-runnable (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY IF EXISTS + CREATE); re-running on itself leaves an identical catalog. Re-pasting 20261116000100 after this
-- file restores the 3-document bodies of save / review / void, the guard and the policy (a packing match then hides only
-- through its other extractions and a new packing match cannot be saved): re-paste this file right after.
-- Down-path (staging only): void the match-v2 rows first; re-paste 20261116000100 §3 – §5 (helpers, policy, RPCs); DROP
-- FUNCTION app.doc_match_rows_check(jsonb, text, boolean), app.doc_match_visible(uuid, uuid, uuid, uuid, uuid, uuid); ALTER
-- TABLE public.document_matches DROP COLUMN packing_extraction_id (only when no row uses it).
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261125000100') THEN
    RAISE EXCEPTION 'MATCH PACKING preflight: apply legacy_import first (schema_versions lacks 20261125000100 legacy_import)';
  END IF;
  IF to_regclass('public.document_matches') IS NULL OR to_regprocedure('public.save_document_match(uuid,jsonb)') IS NULL
     OR to_regprocedure('app.doc_match_visible(uuid,uuid,uuid,uuid,uuid)') IS NULL
     OR NOT ('packing_list' = ANY (app.document_kinds())) THEN
    RAISE EXCEPTION 'MATCH PACKING preflight: document matching objects missing (apply 20261116000100 doc_match)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261126000100', 'doc_match_packing')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. column: the packing list extraction (optional)
-- ---------------------------------------------------------------------
ALTER TABLE public.document_matches ADD COLUMN IF NOT EXISTS packing_extraction_id uuid;
ALTER TABLE public.document_matches DROP CONSTRAINT IF EXISTS document_matches_pack_fk;
ALTER TABLE public.document_matches ADD CONSTRAINT document_matches_pack_fk
  FOREIGN KEY (packing_extraction_id, org_id) REFERENCES public.document_extractions(id, org_id);
ALTER TABLE public.document_matches DROP CONSTRAINT IF EXISTS document_matches_pack_distinct_chk;
ALTER TABLE public.document_matches ADD CONSTRAINT document_matches_pack_distinct_chk CHECK (
  packing_extraction_id IS NULL
  OR (packing_extraction_id <> invoice_extraction_id AND packing_extraction_id <> bl_extraction_id
      AND packing_extraction_id IS DISTINCT FROM declaration_extraction_id));
ALTER TABLE public.document_matches DROP CONSTRAINT IF EXISTS document_matches_pack_engine_chk;
ALTER TABLE public.document_matches ADD CONSTRAINT document_matches_pack_engine_chk CHECK (
  packing_extraction_id IS NULL OR engine_version = 'match-v2');
CREATE INDEX IF NOT EXISTS document_matches_pack_idx ON public.document_matches (packing_extraction_id);
COMMENT ON COLUMN public.document_matches.packing_extraction_id IS 'Optional packing list (بيان التعبئة) reading of the match: a document_extractions row of doc_type packing_list of the same org (20261126000100). Set only on engine match-v2 rows; mode (two_way / three_way) is decided by the customs declaration alone.';
COMMENT ON TABLE public.document_matches IS 'Saved invoice ↔ B/L (↔ customs declaration) (↔ packing list, 20261126000100) matches of ocr.html (engine assets/js/doc-match.js). Written only by public.save_document_match / review_document_match / void_document_match; no DELETE (void instead). Staff of the org only, branch-scoped through the transaction like document_extractions.';

-- ---------------------------------------------------------------------
-- 2. helpers + guard
-- ---------------------------------------------------------------------
-- rows of a match → NULL when valid, else the detail of the first problem ('rows', 'rows.key', 'rows.status', …).
-- p_mode two_way: no value / confidence / pair may name the declaration. p_packing false: none may name the packing list.
CREATE OR REPLACE FUNCTION app.doc_match_rows_check(p_rows jsonb, p_mode text, p_packing boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  r     jsonb;
  e     record;
  v_key text;
  v_seen text[] := ARRAY[]::text[];
  v_docs text[] := CASE WHEN p_mode = 'three_way' THEN ARRAY['invoice','bl','declaration'] ELSE ARRAY['invoice','bl'] END
                   || CASE WHEN coalesce(p_packing, false) THEN ARRAY['packing'] ELSE ARRAY[]::text[] END;
  v_pairs text[] := CASE WHEN p_mode = 'three_way' THEN ARRAY['inv_bl','inv_decl','bl_decl'] ELSE ARRAY['inv_bl'] END
                    || CASE WHEN NOT coalesce(p_packing, false) THEN ARRAY[]::text[]
                            WHEN p_mode = 'three_way' THEN ARRAY['inv_pack','bl_pack','decl_pack']
                            ELSE ARRAY['inv_pack','bl_pack'] END;
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
    -- values: {invoice?, bl?, declaration?, packing?} → string / number / boolean / null, or an array of those (≤ 200)
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
    -- conf: {invoice?, bl?, declaration?, packing?} → a number 0..1 or null
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
    -- pairs: {inv_bl?, inv_decl?, bl_decl?, inv_pack?, bl_pack?, decl_pack?} → a status or null
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

-- the 2-argument form (20261116000100): the same check without the packing list
CREATE OR REPLACE FUNCTION app.doc_match_rows_check(p_rows jsonb, p_mode text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.doc_match_rows_check(p_rows, p_mode, false)
$$;

-- the caller may see this match: staff of the org; the match's transaction and every linked extraction's transaction
-- (invoice, B/L, declaration, packing list) on the caller's branches
CREATE OR REPLACE FUNCTION app.doc_match_visible(p_org uuid, p_tx uuid, p_inv uuid, p_bl uuid, p_decl uuid, p_pack uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_staff(p_org)
     AND (p_tx IS NULL OR app.has_tx_role(p_tx, app.staff_roles()))
     AND NOT EXISTS (SELECT 1 FROM public.document_extractions e
                      WHERE e.id IN (p_inv, p_bl, p_decl, p_pack) AND e.transaction_id IS NOT NULL
                        AND e.transaction_id IS DISTINCT FROM p_tx
                        AND NOT app.has_tx_role(e.transaction_id, app.staff_roles()))
$$;

-- the 5-argument form (20261116000100): the same rule without a packing list
CREATE OR REPLACE FUNCTION app.doc_match_visible(p_org uuid, p_tx uuid, p_inv uuid, p_bl uuid, p_decl uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.doc_match_visible(p_org, p_tx, p_inv, p_bl, p_decl, NULL::uuid)
$$;

-- machine result immutable (+ the packing list); only the review / void columns change; a voided row is frozen
CREATE OR REPLACE FUNCTION app.tg_document_matches_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_MATCH_VOIDED'); END IF;
  PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
    'id','org_id','transaction_id','invoice_extraction_id','bl_extraction_id','declaration_extraction_id',
    'packing_extraction_id','mode','engine_version','overall','match_count','mismatch_count','partial_count',
    'missing_count','rows','note','created_by','created_at']);
  IF OLD.status = 'reviewed' AND NEW.status = 'saved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'status'); END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 3. RLS: the SELECT policy through the 4-document visibility rule
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS document_matches_select ON public.document_matches;
CREATE POLICY document_matches_select ON public.document_matches FOR SELECT TO authenticated
  USING (app.doc_match_visible(org_id, transaction_id, invoice_extraction_id, bl_extraction_id, declaration_extraction_id,
                               packing_extraction_id));

-- ---------------------------------------------------------------------
-- 4. RPCs (re-created, same arguments)
-- ---------------------------------------------------------------------
-- save_document_match(p_org, p_payload) — staff of the org. payload = {transaction_id?, invoice_extraction_id,
-- bl_extraction_id, declaration_extraction_id?, packing_extraction_id?, mode, engine_version ('match-v1' | 'match-v2' ⇔
-- packing), overall, counts {match, mismatch, partial, missing}, rows [...], reviewed_rows [...]?, note?, idempotencyKey?}
-- → {id, created_at, status, transaction_id, mode, overall}
CREATE OR REPLACE FUNCTION public.save_document_match(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key     uuid;
  v_replay  jsonb;
  v_tx      uuid;
  v_ids     uuid[];
  v_slots   text[] := ARRAY['invoice_extraction_id','bl_extraction_id','declaration_extraction_id','packing_extraction_id'];
  v_kinds   text[] := ARRAY['commercial_invoice','bill_of_lading','customs_declaration','packing_list'];
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
    'declaration_extraction_id','packing_extraction_id','mode','engine_version','overall','counts','rows','reviewed_rows',
    'note','idempotencyKey']);
  v_key := app.idem_key_from(p_payload);
  v_replay := app.idem_begin('save_document_match', v_key, p_payload - 'idempotencyKey', p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  -- mode / engine / overall
  v_mode := app.ptext(p_payload, 'mode', 20, true);
  IF v_mode NOT IN ('two_way','three_way') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  v_engine := app.ptext(p_payload, 'engine_version', 20, true);
  IF v_engine NOT IN ('match-v1','match-v2') THEN PERFORM app.fail('MRS_INVALID', 'engine_version'); END IF;
  v_overall := app.ptext(p_payload, 'overall', 20, true);
  IF v_overall NOT IN ('match','mismatch','review') THEN PERFORM app.fail('MRS_INVALID', 'overall'); END IF;

  -- the transaction (optional): of the org, on the caller's branches
  v_tx := app.puuid(p_payload, 'transaction_id');
  IF v_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = v_tx AND t.org_id = p_org
                                         AND app.has_tx_role(t.id, app.staff_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;

  -- the extractions: invoice + B/L required, declaration ⇔ three_way, packing list ⇔ match-v2
  v_ids := ARRAY[app.puuid(p_payload, 'invoice_extraction_id'), app.puuid(p_payload, 'bl_extraction_id'),
                 app.puuid(p_payload, 'declaration_extraction_id'), app.puuid(p_payload, 'packing_extraction_id')];
  IF v_ids[1] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'invoice_extraction_id'); END IF;
  IF v_ids[2] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bl_extraction_id'); END IF;
  IF v_mode = 'three_way' AND v_ids[3] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_extraction_id'); END IF;
  IF v_mode = 'two_way' AND v_ids[3] IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  IF v_engine = 'match-v2' AND v_ids[4] IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'packing_extraction_id'); END IF;
  IF v_engine = 'match-v1' AND v_ids[4] IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'engine_version'); END IF;
  IF v_ids[1] = v_ids[2] THEN PERFORM app.fail('MRS_INVALID', 'bl_extraction_id'); END IF;
  IF v_ids[3] IN (v_ids[1], v_ids[2]) THEN PERFORM app.fail('MRS_INVALID', 'declaration_extraction_id'); END IF;
  IF v_ids[4] IN (v_ids[1], v_ids[2]) OR v_ids[4] = v_ids[3] THEN PERFORM app.fail('MRS_INVALID', 'packing_extraction_id'); END IF;
  FOR v_i IN 1..4 LOOP
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

  -- rows (the packing value / confidence / pair keys only with a packing list)
  v_rows := p_payload -> 'rows';
  v_bad := app.doc_match_rows_check(v_rows, v_mode, v_ids[4] IS NOT NULL);
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

  -- overall must not contradict the rows (match-v1 / v2: a critical mismatch → mismatch; match only without any mismatch
  -- row and without a critical row that is partial / missing)
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
    declaration_extraction_id, packing_extraction_id, mode, engine_version, overall, match_count, mismatch_count,
    partial_count, missing_count, rows, reviewed_rows, note, status, created_by, created_at)
  VALUES (p_org, v_tx, v_ids[1], v_ids[2], v_ids[3], v_ids[4], v_mode, v_engine, v_overall, v_n[1], v_n[2], v_n[3], v_n[4],
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
                                                m.declaration_extraction_id, m.packing_extraction_id) THEN
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
                                                m.declaration_extraction_id, m.packing_extraction_id) THEN
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
-- 5. privileges (as 20261116000100 §7; the re-created functions keep their ACL, the new overloads get the same one)
-- ---------------------------------------------------------------------
-- the RLS policy runs as the caller: the visibility helpers (SECURITY DEFINER, read-only) are executable by authenticated
REVOKE EXECUTE ON FUNCTION app.doc_match_visible(uuid, uuid, uuid, uuid, uuid, uuid), app.doc_match_visible(uuid, uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.doc_match_visible(uuid, uuid, uuid, uuid, uuid, uuid), app.doc_match_visible(uuid, uuid, uuid, uuid, uuid)
TO authenticated;
-- pure validators + the trigger function: called by SECURITY DEFINER code (owner) / the triggers only
REVOKE EXECUTE ON FUNCTION app.doc_match_rows_check(jsonb, text, boolean), app.doc_match_rows_check(jsonb, text),
  app.tg_document_matches_guard()
FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only (the Edge Functions' service_role has no use for them)
REVOKE ALL ON FUNCTION public.save_document_match(uuid, jsonb), public.review_document_match(uuid, jsonb, text),
  public.void_document_match(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_document_match(uuid, jsonb), public.review_document_match(uuid, jsonb, text),
  public.void_document_match(uuid, text) TO authenticated;
