-- =====================================================================
-- 20261129000100_mfa_off — two-step verification (TOTP) is no longer required (owner's decision, 2026-11-15)
--   * app.mfa_gated_roles() → '{}' : no membership role needs an aal2 session (has_role / my_context / admin gates)
--   * app.mfa_required_for()      : platform admins no longer need it either
--   * app.is_platform_admin()     : no aal2 condition
--   * app.li_gate()               : the legacy-import gate keeps owner_only, drops the aal2 condition
--   Users who still have a verified factor are challenged by Supabase Auth at sign-in (aal1 → aal2); removing the
--   factor (account security page, or auth.mfa_factors) stops that. To restore: re-apply 20261109000100 / 20261125000100
--   definitions (mfa_gated_roles = ARRAY['admin']).
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261128000100') THEN
    RAISE EXCEPTION 'MFA OFF preflight: apply return_extension first (schema_versions lacks 20261128000100)';
  END IF;
  IF to_regprocedure('app.mfa_gated_roles()') IS NULL OR to_regprocedure('app.li_gate(uuid)') IS NULL THEN
    RAISE EXCEPTION 'MFA OFF preflight: mfa / legacy_import objects missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261129000100', 'mfa_off')
ON CONFLICT (version) DO NOTHING;

CREATE OR REPLACE FUNCTION app.mfa_gated_roles() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '{}'::text[]
$$;

CREATE OR REPLACE FUNCTION app.mfa_required_for(p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.memberships m
      JOIN public.organizations o ON o.id = m.org_id AND o.is_active
     WHERE m.user_id = p_uid AND m.is_active AND m.role = ANY (app.mfa_gated_roles())
       AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
$$;

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid())
$$;

CREATE OR REPLACE FUNCTION app.li_gate(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.li_is_owner(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner_only'); END IF;
END $$;

-- CREATE OR REPLACE keeps each function's ACL; re-asserted
REVOKE ALL ON FUNCTION app.mfa_required_for(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app.is_platform_admin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.mfa_gated_roles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.mfa_gated_roles() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION app.li_gate(uuid) FROM PUBLIC, anon, authenticated;
