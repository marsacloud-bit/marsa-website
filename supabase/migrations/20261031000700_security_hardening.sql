-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0700 — security review hardening (additive).
--
-- 1. Column-level privacy: RLS limits ROWS, not columns. A client who may
--    read his own transaction / client record must not receive internal
--    staff fields. Those columns are removed from the API roles' SELECT
--    grant; staff read them through public.staff_internal_fields().
--      transactions.notes, transactions.tracking_token_hash,
--      clients.notes, clients.classification,
--      service_requests.tracking_token_hash
--    (UPDATE stays granted, so staff can still write notes; RLS still decides rows.)
--    NOTE: a column added later to these tables is NOT selectable until it is
--    added to the column grant below (fail closed).
-- 2. Sequences: visitors get no USAGE on identity sequences.
-- 3. Default privileges: future tables/sequences in public are not granted to anon.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. column grants
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('transactions',     ARRAY['notes','tracking_token_hash']),
      ('clients',          ARRAY['notes','classification']),
      ('service_requests', ARRAY['tracking_token_hash'])) AS x(tbl, hidden)
  LOOP
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND NOT (c.column_name = ANY (r.hidden));
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', r.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, r.tbl);
  END LOOP;
END $$;

-- staff-only reader for the hidden internal fields (row access = same rules as the table policies)
CREATE OR REPLACE FUNCTION public.staff_internal_fields(p_table text, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_ids) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  IF p_table = 'transactions' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(t.id::text, jsonb_build_object('notes', t.notes))
        FROM public.transactions t
       WHERE t.id = ANY (p_ids) AND app.has_branch_role(t.org_id, t.branch_id, app.staff_roles())), '{}'::jsonb);
  ELSIF p_table = 'clients' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(c.id::text, jsonb_build_object('notes', c.notes, 'classification', c.classification))
        FROM public.clients c
       WHERE c.id = ANY (p_ids) AND app.is_staff(c.org_id)), '{}'::jsonb);
  END IF;
  PERFORM app.fail('MRS_INVALID', 'table');
  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION public.staff_internal_fields(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_internal_fields(text, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------
-- 2./3. sequences + default privileges
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
