-- =====================================================================
-- 20261202000100_org_logo — the organisation logo (2026-11-16)
--   organizations.settings.logo_path already exists (public.admin_update_org whitelist, 20261102000200: an object path,
--   never a URL, under '<org_id>/'); this file gives it a home and a reader:
--   1. a PRIVATE Storage bucket 'org-assets' — images only (image/png, image/jpeg, image/webp; no SVG: no script content),
--      1 MiB per object. Object name: '<org_id>/<file>' (exactly two segments, lower-case org uuid, no '..').
--   2. app.org_asset_org(name) → the org uuid of a well-formed object name (NULL otherwise);
--      app.org_asset_can(name, mode) — the storage.objects policy test (evaluated as the caller):
--        'read'   = an active member of that org (staff or a portal 'client' membership, app.is_member) or a portal user
--                   of an active client of that org (app.my_client_ids);
--        'write'  = an org admin (app.has_role(org, '{admin}') — the rule admin_update_org uses to change logo_path) and the
--                   file is 'logo-<10..16 digits>.(png|jpg|webp)';
--        'delete' = an org admin (any well-formed name of the org's folder).
--      Policies marsa_org_assets_read (SELECT), marsa_org_assets_insert (INSERT), marsa_org_assets_update (UPDATE),
--      marsa_org_assets_delete (DELETE) on storage.objects, TO authenticated only.
--   3. public.my_context() (20261109000100 body, re-created; every existing key unchanged): + 'logo_path' on each
--      organizations[] row, + 'org_logo_path' on each memberships[] and clients[] row (organizations.settings ->> 'logo_path',
--      NULL when unset). The page asks supa.js orgLogoUrl(path) for a short-lived signed URL.
--   MFA stays off (20261129000100_mfa_off): no aal2 requirement is added.
--   Re-runnable (ON CONFLICT / DROP POLICY IF EXISTS + CREATE / CREATE OR REPLACE); changes no data.
--   Down-path: DROP POLICY marsa_org_assets_read / _insert / _update / _delete ON storage.objects;
--   DROP FUNCTION app.org_asset_can(text, text), app.org_asset_org(text); re-create public.my_context() from
--   20261109000100 (its body, verbatim); DELETE FROM storage.objects WHERE bucket_id = 'org-assets' (through the Storage API,
--   so the bytes go too) then DELETE FROM storage.buckets WHERE id = 'org-assets'; DELETE FROM public.schema_versions
--   WHERE version = '20261202000100'. A settings.logo_path set in the meantime is kept (it then points at nothing).
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261201000100') THEN
    RAISE EXCEPTION 'ORG LOGO preflight: apply legacy_gaps first (schema_versions lacks 20261201000100)';
  END IF;
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL
     OR to_regprocedure('public.admin_update_org(uuid,jsonb)') IS NULL OR to_regprocedure('app.is_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ORG LOGO preflight: Storage (storage.buckets / storage.objects) or admin_update_org / app.is_member missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261202000100', 'org_logo')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. bucket 'org-assets' (private, images only, 1 MiB)
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('org-assets', 'org-assets', false, 1048576, ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 2. policy helpers
-- ---------------------------------------------------------------------
-- '<org uuid>/<file>' → the org uuid; anything else (deeper path, '..', upper-case uuid, odd characters) → NULL
CREATE OR REPLACE FUNCTION app.org_asset_org(p_name text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$'
         AND position('..' IN p_name) = 0
    THEN split_part(p_name, '/', 1)::uuid
  END
$$;

-- the storage.objects test for bucket 'org-assets' (p_mode: read | write | delete)
CREATE OR REPLACE FUNCTION app.org_asset_can(p_name text, p_mode text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(auth.uid() IS NOT NULL AND x.org IS NOT NULL AND CASE p_mode
    WHEN 'read' THEN app.is_member(x.org)
                     OR EXISTS (SELECT 1 FROM public.clients c WHERE c.org_id = x.org AND c.id IN (SELECT app.my_client_ids()))
    WHEN 'write' THEN split_part(p_name, '/', 2) ~ '^logo-[0-9]{10,16}\.(png|jpg|webp)$' AND app.has_role(x.org, ARRAY['admin'])
    WHEN 'delete' THEN app.has_role(x.org, ARRAY['admin'])
    ELSE false
  END, false)
  FROM (SELECT app.org_asset_org(p_name) org) x
$$;

DROP POLICY IF EXISTS marsa_org_assets_read ON storage.objects;
DROP POLICY IF EXISTS marsa_org_assets_insert ON storage.objects;
DROP POLICY IF EXISTS marsa_org_assets_update ON storage.objects;
DROP POLICY IF EXISTS marsa_org_assets_delete ON storage.objects;

CREATE POLICY marsa_org_assets_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'org-assets' AND app.org_asset_can(name, 'read'));

CREATE POLICY marsa_org_assets_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'org-assets' AND app.org_asset_can(name, 'write'));

CREATE POLICY marsa_org_assets_update ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'org-assets' AND app.org_asset_can(name, 'write'))
WITH CHECK (bucket_id = 'org-assets' AND app.org_asset_can(name, 'write'));

CREATE POLICY marsa_org_assets_delete ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'org-assets' AND app.org_asset_can(name, 'delete'));

-- ---------------------------------------------------------------------
-- 3. my_context (20261109000100 body; ORG LOGO: + logo_path / org_logo_path)
-- ---------------------------------------------------------------------
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
               'org_logo_path', o.settings ->> 'logo_path',                                                       -- ORG LOGO
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
      SELECT jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', c.org_id, 'name_ar', c.name_ar, 'link_role', cu.role,
                                          'org_logo_path', o.settings ->> 'logo_path'))                          -- ORG LOGO
        FROM public.client_users cu JOIN public.clients c ON c.id = cu.client_id
        JOIN public.organizations o ON o.id = c.org_id                                                          -- ORG LOGO
       -- same rule as data access: active client + active org + client membership not deactivated
       WHERE cu.user_id = v_uid AND cu.is_active AND cu.client_id IN (SELECT app.my_client_ids())), '[]'::jsonb),
    'is_platform_admin', app.is_platform_admin(),
    'organizations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en,
               'environment', o.environment, 'default_locale', o.default_locale, 'roles', to_jsonb(x.roles),
               'logo_path', o.settings ->> 'logo_path')                                                           -- ORG LOGO
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
-- privileges
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.org_asset_org(text) FROM PUBLIC, anon, authenticated, service_role;
-- evaluated inside the storage.objects policies as the caller → authenticated only
REVOKE ALL ON FUNCTION app.org_asset_can(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.org_asset_can(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.my_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_context() TO authenticated;
