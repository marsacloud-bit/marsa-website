-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261109000100 — MFA (TOTP, Supabase Auth MFA) REQUIRED for organization admins
-- (memberships.role = 'admin') and platform admins (public.platform_admins) (docs/online/MFA_SPEC.md). Builds on G7.
--
-- Rule: an 'admin' membership row, and a platform_admins row, grant their privilege ONLY when the session's JWT
-- claim aal = 'aal2'. A missing / empty aal claim counts as 'aal1' (fail closed). Every other role is unaffected.
-- Enforcement is per membership row (admin in org A + clearance_staff in org M at aal1: org A gives nothing, org M
-- works as before); the UI enforces per user through my_context().mfa.
--   P. preflight (G7 applied, auth.mfa_factors present) + schema_versions row
--   1. helpers     app.mfa_gated_roles, app.session_aal, app.mfa_ok, app.mfa_factor_verified, app.mfa_required_for,
--                  app.mfa_required_reasons, app.mfa_pending
--   2. re-created  app.is_member, app.has_role, app.has_branch_role (bodies from 20261102000200 §2b),
--                  app.rpt_scope (20261106000100), app.is_platform_admin (20261102000200 §5),
--                  app.fail (20261031000300 §2: MRS_FORBIDDEN / MRS_NOT_FOUND → MRS_MFA_REQUIRED for an MFA-pending
--                  caller only), public.my_context (20261102000200 §13: additive 'mfa' object + 'mfa_locked' per row)
--   2b. ownership paths that bypassed the role helpers (review fixes):
--                  app.can_read_batch / app.can_edit_batch + policies import_batches_select / import_batches_update
--                  (20261031000300: the creator branch now also needs app.is_member → an aal1 admin-only creator, and a
--                  deactivated creator, lose their import staging rows), public.accept_invitation (20261102000200 §11:
--                  the self-invitation guard judges THIS session → app.has_branch_role, MFA-gated, instead of
--                  app.uid_has_branch_role)
--   3. privileges  (re-asserted identically for the re-created functions)
-- Adds no table, column, trigger or public function; re-creates 2 policies (2b). Unchanged on purpose:
-- app.uid_has_branch_role, app.bm_client_in_scope, app.invitation_authorized (they judge the INVITER's standing by
-- uid, not this session).
-- Re-runnable (CREATE OR REPLACE / DROP POLICY IF EXISTS / ON CONFLICT DO NOTHING). Re-pasting 20261031000300, 20261102000200 or
-- 20261106000100 after this file silently restores the pre-MFA bodies: re-paste this file right after (MFA_AR.md).
-- Down-path: not recommended (re-pasting the older bodies switches MFA enforcement off); see MFA_AR.md.
-- =====================================================================

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261108000100') THEN
    RAISE EXCEPTION 'MFA preflight: apply G7 first (schema_versions lacks 20261108000100 g7_subscriptions)';
  END IF;
  IF to_regclass('auth.mfa_factors') IS NULL THEN
    RAISE EXCEPTION 'MFA preflight: auth.mfa_factors not found (Supabase Auth MFA schema missing)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261109000100', 'mfa')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. helpers
-- ---------------------------------------------------------------------
-- the membership roles that need an aal2 session (single place to extend, e.g. 'branch_manager')
CREATE OR REPLACE FUNCTION app.mfa_gated_roles() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['admin']
$$;

-- the session's authenticator assurance level; missing / empty claim = 'aal1'
CREATE OR REPLACE FUNCTION app.session_aal() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1')
$$;

CREATE OR REPLACE FUNCTION app.mfa_ok() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT app.session_aal() = 'aal2'
$$;

-- a verified TOTP factor exists (Supabase: enums auth.factor_type / auth.factor_status → compared as text)
CREATE OR REPLACE FUNCTION app.mfa_factor_verified(p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM auth.mfa_factors f
     WHERE f.user_id = p_uid AND f.factor_type::text = 'totp' AND f.status::text = 'verified')
$$;

-- MFA is required: an active gated membership in an active org (same branch rule as has_role) or a platform-admin row
CREATE OR REPLACE FUNCTION app.mfa_required_for(p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_uid IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.memberships m
              JOIN public.organizations o ON o.id = m.org_id AND o.is_active
             WHERE m.user_id = p_uid AND m.is_active AND m.role = ANY (app.mfa_gated_roles())
               AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
    OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p_uid))
$$;

-- why MFA is required: ["org_admin"], ["platform_admin"], both, or []
CREATE OR REPLACE FUNCTION app.mfa_required_reasons(p_uid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.r ORDER BY x.o), '[]'::jsonb)
    FROM (SELECT 'org_admin' r, 1 o
           WHERE p_uid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.memberships m
                   JOIN public.organizations o ON o.id = m.org_id AND o.is_active
                  WHERE m.user_id = p_uid AND m.is_active AND m.role = ANY (app.mfa_gated_roles())
                    AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
          UNION ALL
          SELECT 'platform_admin', 2
           WHERE p_uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p_uid)) x
$$;

-- the caller needs MFA and the session is not aal2 (only the caller's own state: no oracle about other tenants)
CREATE OR REPLACE FUNCTION app.mfa_pending() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND NOT app.mfa_ok() AND app.mfa_required_for(auth.uid())
$$;

-- ---------------------------------------------------------------------
-- 2. re-created access helpers: an admin row counts only at aal2
--    MFA_ROW = (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active
      AND (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())
      AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
$$;

CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
      AND (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())
      AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
$$;

-- role valid for this branch: org-wide membership (branch_id NULL) or same (active) branch
CREATE OR REPLACE FUNCTION app.has_branch_role(p_org uuid, p_branch uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
      AND (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())
      AND (m.branch_id IS NULL
           OR (m.branch_id = p_branch AND EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active))))
$$;

-- G6a branch scope (NULL = org-wide, else the active branches; '{}' = no rows), MFA_ROW in both sub-selects
CREATE OR REPLACE FUNCTION app.rpt_scope(p_org uuid, p_roles text[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.memberships m JOIN public.organizations o ON o.id = m.org_id AND o.is_active
                  WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
                    AND (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())
                    AND m.branch_id IS NULL)
      THEN NULL::uuid[]
    ELSE coalesce((SELECT array_agg(DISTINCT m.branch_id) FROM public.memberships m
                     JOIN public.organizations o ON o.id = m.org_id AND o.is_active
                     JOIN public.branches b ON b.id = m.branch_id AND b.is_active
                    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
                      AND (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())), '{}'::uuid[])
  END
$$;

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND app.mfa_ok()
     AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid())
$$;

-- error helper: a clear MRS_MFA_REQUIRED (detail aal2) instead of MRS_FORBIDDEN / MRS_NOT_FOUND, only for a caller
-- who needs MFA and is not at aal2; every other caller (and anon / service role: auth.uid() NULL) gets the old error
CREATE OR REPLACE FUNCTION app.fail(p_code text, p_detail text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_code IN ('MRS_FORBIDDEN', 'MRS_NOT_FOUND') AND app.mfa_pending() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_MFA_REQUIRED', DETAIL = 'aal2';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = coalesce(p_detail, '');
END $$;

-- my_context(): works at aal1; every existing key unchanged, is_platform_admin = effective value,
-- + 'mfa_locked' per membership row + 'mfa' {aal, required, reasons, enrolled, satisfied}
CREATE OR REPLACE FUNCTION public.my_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_aal text;
  v_ok  boolean;
  v_req boolean;
BEGIN
  IF v_uid IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_aal := app.session_aal();
  v_ok  := app.mfa_ok();
  v_req := app.mfa_required_for(v_uid);
  RETURN jsonb_build_object(
    'user_id', v_uid,
    'profile', (SELECT to_jsonb(p) FROM public.profiles p WHERE p.id = v_uid),
    'memberships', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', m.org_id, 'org_slug', o.slug, 'org_name_ar', o.name_ar, 'org_name_en', o.name_en,
               'environment', o.environment,
               'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
               'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
               'mfa_locked', (m.role = ANY (app.mfa_gated_roles()) AND NOT v_ok))
             ORDER BY o.slug, s.sort DESC)
        FROM public.memberships m
        JOIN public.organizations o ON o.id = m.org_id AND o.is_active
        LEFT JOIN public.branches b ON b.id = m.branch_id
        LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
       WHERE m.user_id = v_uid AND m.is_active), '[]'::jsonb),
    'clients', coalesce((
      SELECT jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', c.org_id, 'name_ar', c.name_ar, 'link_role', cu.role))
        FROM public.client_users cu JOIN public.clients c ON c.id = cu.client_id
       -- same rule as data access: active client + active org + client membership not deactivated
       WHERE cu.user_id = v_uid AND cu.is_active AND cu.client_id IN (SELECT app.my_client_ids())), '[]'::jsonb),
    'is_platform_admin', app.is_platform_admin(),
    'organizations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en,
               'environment', o.environment, 'default_locale', o.default_locale, 'roles', to_jsonb(x.roles))
             ORDER BY o.slug)
        FROM (SELECT m.org_id, array_agg(DISTINCT m.role ORDER BY m.role) roles
                FROM public.memberships m WHERE m.user_id = v_uid AND m.is_active GROUP BY m.org_id) x
        JOIN public.organizations o ON o.id = x.org_id AND o.is_active), '[]'::jsonb),
    'mfa', jsonb_build_object(
      'aal', v_aal,
      'required', v_req,
      'reasons', app.mfa_required_reasons(v_uid),
      'enrolled', app.mfa_factor_verified(v_uid),
      'satisfied', (NOT v_req OR v_ok)));
END $$;

-- ---------------------------------------------------------------------
-- 2b. ownership paths that did not go through the role helpers
-- ---------------------------------------------------------------------
-- import staging: the creator keeps access only while still a (MFA-satisfied) member of the batch's org
CREATE OR REPLACE FUNCTION app.can_read_batch(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.import_batches b
                 WHERE b.id = p_batch
                   AND ((b.created_by = auth.uid() AND app.is_member(b.org_id))
                        OR app.has_role(b.org_id, app.ops_writer_roles())))
$$;

CREATE OR REPLACE FUNCTION app.can_edit_batch(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.import_batches b
                 WHERE b.id = p_batch AND b.status = 'draft'
                   AND ((b.created_by = auth.uid() AND app.is_member(b.org_id))
                        OR app.has_role(b.org_id, app.ops_writer_roles())))
$$;

DROP POLICY IF EXISTS import_batches_select ON public.import_batches;
CREATE POLICY import_batches_select ON public.import_batches FOR SELECT TO authenticated
  USING ((created_by = auth.uid() AND app.is_member(org_id)) OR app.has_role(org_id, app.ops_writer_roles()));
DROP POLICY IF EXISTS import_batches_update ON public.import_batches;
CREATE POLICY import_batches_update ON public.import_batches FOR UPDATE TO authenticated
  USING ((created_by = auth.uid() AND app.is_member(org_id)) OR app.has_role(org_id, app.ops_writer_roles()))
  WITH CHECK ((created_by = auth.uid() AND app.is_member(org_id)) OR app.has_role(org_id, app.ops_writer_roles()));

-- accept_invitation (body from 20261102000200 §11; only the self-invitation guard changed)
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_i    public.invitations;
  v_user record;
  v_m    public.memberships;
  v_role text;
  v_cu   uuid;
BEGIN
  IF v_uid IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  SELECT * INTO v_i FROM public.invitations i WHERE i.token_hash = app.hash_token(p_token) FOR UPDATE;
  IF v_i.id IS NULL OR v_i.revoked_at IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_i.org_id AND o.is_active) THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;
  v_role := v_i.role;

  IF v_i.accepted_at IS NOT NULL THEN
    IF v_i.accepted_by IS DISTINCT FROM v_uid THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
    -- replay: fall through to the result below without touching anything
  ELSE
    -- the inviter must still hold the authority to grant this (same error as revoked)
    IF NOT app.invitation_authorized(v_i) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
    IF v_i.expires_at <= now() THEN PERFORM app.fail('MRS_EXPIRED'); END IF;
    SELECT u.email, u.email_confirmed_at INTO v_user FROM auth.users u WHERE u.id = v_uid;
    IF v_user.email IS NULL OR lower(btrim(v_user.email)) <> v_i.email THEN PERFORM app.fail('MRS_EMAIL_MISMATCH'); END IF;
    IF v_user.email_confirmed_at IS NULL THEN PERFORM app.fail('MRS_EMAIL_UNCONFIRMED'); END IF;
    -- self-invitations only count when an org admin issued them, judged on THIS session (MFA: an aal1 admin row
    -- does not count → MRS_MFA_REQUIRED via app.fail)
    IF v_i.invited_by = v_uid AND NOT app.has_branch_role(v_i.org_id, NULL, ARRAY['admin']) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'self_invite');
    END IF;
    IF v_i.branch_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.branches b WHERE b.id = v_i.branch_id AND b.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'branch');
    END IF;
    IF v_i.client_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.clients c WHERE c.id = v_i.client_id AND c.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'client');
    END IF;

    INSERT INTO public.profiles (id) VALUES (v_uid) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_m FROM public.memberships m
     WHERE m.user_id = v_uid AND m.org_id = v_i.org_id AND m.role = v_role
       AND m.branch_id IS NOT DISTINCT FROM v_i.branch_id
     FOR UPDATE;
    IF v_m.id IS NULL THEN
      INSERT INTO public.memberships (user_id, org_id, branch_id, role, created_by)
      VALUES (v_uid, v_i.org_id, v_i.branch_id, v_role, v_i.invited_by);
    ELSIF NOT v_m.is_active THEN
      UPDATE public.memberships m SET is_active = true WHERE m.id = v_m.id;
    END IF;
    IF v_i.client_id IS NOT NULL THEN
      INSERT INTO public.client_users AS cu (org_id, client_id, user_id, role, created_by)
      VALUES (v_i.org_id, v_i.client_id, v_uid, 'member', v_i.invited_by)
      ON CONFLICT (client_id, user_id) DO UPDATE SET is_active = true WHERE NOT cu.is_active;
    END IF;
    UPDATE public.invitations i SET accepted_at = now(), accepted_by = v_uid WHERE i.id = v_i.id RETURNING * INTO v_i;
  END IF;

  SELECT * INTO v_m FROM public.memberships m
   WHERE m.user_id = v_uid AND m.org_id = v_i.org_id AND m.role = v_role
     AND m.branch_id IS NOT DISTINCT FROM v_i.branch_id;
  SELECT cu.id INTO v_cu FROM public.client_users cu WHERE cu.client_id = v_i.client_id AND cu.user_id = v_uid;
  RETURN jsonb_build_object('invitation_id', v_i.id, 'org_id', v_i.org_id,
                            'org_slug', (SELECT o.slug FROM public.organizations o WHERE o.id = v_i.org_id),
                            'role', v_i.role, 'branch_id', v_i.branch_id, 'client_id', v_i.client_id,
                            'membership_id', v_m.id, 'client_user_id', v_cu, 'accepted_at', v_i.accepted_at);
END $$;

-- ---------------------------------------------------------------------
-- 3. privileges
-- ---------------------------------------------------------------------
-- new helpers: nothing by default (PUBLIC gets EXECUTE on a new function in schema app)
REVOKE ALL ON FUNCTION
  app.mfa_gated_roles(), app.session_aal(), app.mfa_ok(), app.mfa_factor_verified(uuid), app.mfa_required_for(uuid),
  app.mfa_required_reasons(uuid), app.mfa_pending()
FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.mfa_factor_verified(uuid), app.mfa_required_for(uuid), app.mfa_required_reasons(uuid)
FROM authenticated, service_role;
-- app.fail runs as the invoker inside invoker triggers / policies → the caller must reach mfa_pending (a boolean
-- about the caller only); the uid-taking helpers stay owner-only
GRANT EXECUTE ON FUNCTION app.mfa_pending(), app.mfa_ok(), app.session_aal(), app.mfa_gated_roles()
TO authenticated, service_role;

-- re-created functions: same privileges as their originals (CREATE OR REPLACE keeps the ACL; re-asserted for a DB
-- where an older file was re-pasted)
REVOKE ALL ON FUNCTION
  app.is_member(uuid), app.has_role(uuid, text[]), app.has_branch_role(uuid, uuid, text[]), app.fail(text, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  app.is_member(uuid), app.has_role(uuid, text[]), app.has_branch_role(uuid, uuid, text[]), app.fail(text, text)
TO authenticated;
REVOKE ALL ON FUNCTION app.is_platform_admin(), app.rpt_scope(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_context() TO authenticated;
REVOKE ALL ON FUNCTION app.can_read_batch(uuid), app.can_edit_batch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.can_read_batch(uuid), app.can_edit_batch(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.accept_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;
