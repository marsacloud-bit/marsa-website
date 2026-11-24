-- =====================================================================
-- 20261211000100_site_profile — the office website reads the office's own identity (2026-11-23)
--   Owner request: every subscribed office customises its website. Stage A: the website shows what the office already
--   keeps in its organisation settings (admin_update_org, 20261102000200) — names, accent colour, phone, e-mail,
--   addresses, logo — instead of fixed text (stage A adds no setting; stage B, item 3, adds five).
--   1. public.site_profile(p_org_slug) → {name_ar, name_en, brand_color, contact_phone, contact_email, address_ar,
--      address_en, logo_path, whatsapp, hours_ar, hours_en, about_ar, about_en} or NULL — anon + authenticated (the website). Only an ACTIVE office, only these
--      public keys (never other settings, ids, members or counters). Unknown / malformed slug → NULL.
--   2. public.site_logo_visible(name) — true only when the object is the CURRENT logo (settings.logo_path) of an active
--      office; policy marsa_org_assets_site_logo (SELECT on storage.objects, TO anon) lets a visitor get a short-lived
--      signed URL for that one object. Every other object of the private bucket 'org-assets' stays members-only.
--   3. Stage B (same day): five new organisation settings the website shows, set in «إعدادات المؤسسة» —
--      whatsapp (a Saudi mobile, stored 05xxxxxxxx like contact_phone), hours_ar / hours_en (working hours, ≤ 120),
--      about_ar / about_en (a short «من نحن» text, ≤ 600). public.admin_update_org (20261102000200 body, re-created;
--      every existing key and rule unchanged) accepts them; site_profile returns them.
--   Re-runnable (CREATE OR REPLACE / DROP POLICY IF EXISTS + CREATE / ON CONFLICT); changes no data.
--   Down-path: DROP POLICY marsa_org_assets_site_logo ON storage.objects; DROP FUNCTION public.site_profile(text),
--   public.site_logo_visible(text); re-create public.admin_update_org from 20261102000200 (its body, verbatim; saved
--   whatsapp / hours_* / about_* keys stay in settings, unused); DELETE FROM public.schema_versions
--   WHERE version = '20261211000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261210000100') THEN
    RAISE EXCEPTION 'SITE PROFILE preflight: apply org_served_ports first (schema_versions lacks 20261210000100)';
  END IF;
  IF to_regclass('storage.objects') IS NULL OR to_regprocedure('app.org_asset_org(text)') IS NULL THEN
    RAISE EXCEPTION 'SITE PROFILE preflight: Storage or app.org_asset_org (org_logo, 20261202000100) missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261211000100', 'site_profile')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the public identity of one office
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.site_profile(p_org_slug text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_o public.organizations; v_s jsonb;
BEGIN
  IF p_org_slug IS NULL OR p_org_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' THEN RETURN NULL; END IF;
  SELECT * INTO v_o FROM public.organizations o WHERE o.slug = p_org_slug AND o.is_active;
  IF v_o.id IS NULL THEN RETURN NULL; END IF;
  v_s := CASE WHEN jsonb_typeof(v_o.settings) = 'object' THEN v_o.settings ELSE '{}'::jsonb END;
  RETURN jsonb_build_object(
    'name_ar', v_o.name_ar,
    'name_en', v_o.name_en,
    'brand_color', CASE WHEN (v_s ->> 'brand_color') ~ '^#[0-9a-fA-F]{6}$' THEN lower(v_s ->> 'brand_color') END,
    'contact_phone', v_s ->> 'contact_phone',
    'contact_email', v_s ->> 'contact_email',
    'address_ar', v_s ->> 'address_ar',
    'address_en', v_s ->> 'address_en',
    'logo_path', CASE WHEN app.org_asset_org(v_s ->> 'logo_path') = v_o.id THEN v_s ->> 'logo_path' END,
    'whatsapp', v_s ->> 'whatsapp',
    'hours_ar', v_s ->> 'hours_ar',
    'hours_en', v_s ->> 'hours_en',
    'about_ar', v_s ->> 'about_ar',
    'about_en', v_s ->> 'about_en');
END $$;
REVOKE EXECUTE ON FUNCTION public.site_profile(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_profile(text) TO anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. a visitor may read exactly the current logo of an active office
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.site_logo_visible(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = app.org_asset_org(p_name) AND o.is_active
       AND jsonb_typeof(o.settings) = 'object' AND o.settings ->> 'logo_path' = p_name)
$$;
-- in public (not app): the anon role has no USAGE on schema app, and a storage policy runs as the caller.
-- Callable as an RPC too; it only answers whether a given (unguessable) object name is an active office's current logo.
REVOKE EXECUTE ON FUNCTION public.site_logo_visible(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_logo_visible(text) TO anon, authenticated;

DROP POLICY IF EXISTS marsa_org_assets_site_logo ON storage.objects;
CREATE POLICY marsa_org_assets_site_logo ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'org-assets' AND public.site_logo_visible(name));

-- ---------------------------------------------------------------------
-- 3. stage B: admin_update_org accepts the website settings (20261102000200 body + 5 keys)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_org(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_o   public.organizations;
  v_s   jsonb;
  v_set jsonb;
  k     text;
  v     text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['name_ar','name_en','default_locale','public_intake_enabled','settings']);
  SELECT * INTO v_o FROM public.organizations o WHERE o.id = p_org FOR UPDATE;

  IF p_payload ? 'name_ar' THEN
    v_o.name_ar := app.ptext(p_payload, 'name_ar', 160, true);
    IF char_length(v_o.name_ar) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
  END IF;
  IF p_payload ? 'name_en' THEN v_o.name_en := app.ptext(p_payload, 'name_en', 160); END IF;
  IF p_payload ? 'default_locale' THEN
    v_o.default_locale := app.ptext(p_payload, 'default_locale', 2, true);
    IF v_o.default_locale NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'default_locale'); END IF;
  END IF;
  IF p_payload ? 'public_intake_enabled' THEN
    IF jsonb_typeof(p_payload -> 'public_intake_enabled') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'public_intake_enabled'); END IF;
    v_o.public_intake_enabled := (p_payload ->> 'public_intake_enabled')::boolean;
  END IF;
  IF p_payload ? 'settings' THEN
    v_s := p_payload -> 'settings';
    PERFORM app.only_keys(v_s, ARRAY['brand_color','contact_phone','contact_email','address_ar','address_en','logo_path',
                                     'whatsapp','hours_ar','hours_en','about_ar','about_en']);
    v_set := coalesce(v_o.settings, '{}'::jsonb);
    FOR k IN SELECT jsonb_object_keys(v_s) LOOP
      v := app.ptext(v_s, k, CASE WHEN k IN ('about_ar','about_en') THEN 600 ELSE 300 END);
      IF v IS NULL THEN v_set := v_set - k; CONTINUE; END IF;
      IF k = 'brand_color' THEN
        IF v !~ '^#[0-9A-Fa-f]{6}$' THEN PERFORM app.fail('MRS_INVALID', 'brand_color'); END IF;
        v := lower(v);
      ELSIF k = 'contact_phone' THEN
        v := app.norm_phone(v, true);
        IF v IS NULL THEN PERFORM app.fail('MRS_INVALID', 'contact_phone'); END IF;
      ELSIF k = 'whatsapp' THEN
        v := app.norm_phone(v, false);   -- a mobile number only (wa.me)
        IF v IS NULL THEN PERFORM app.fail('MRS_INVALID', 'whatsapp'); END IF;
      ELSIF k = 'contact_email' THEN
        v := lower(v);
        IF NOT app.is_email(v) THEN PERFORM app.fail('MRS_INVALID', 'contact_email'); END IF;
      ELSIF k IN ('address_ar','address_en') THEN
        IF char_length(v) > 300 THEN PERFORM app.fail('MRS_TOO_LONG', k); END IF;
      ELSIF k IN ('hours_ar','hours_en') THEN
        IF char_length(v) > 120 THEN PERFORM app.fail('MRS_TOO_LONG', k); END IF;
      ELSIF k = 'logo_path' THEN
        -- a storage object path, never a URL; must live under this org's folder
        IF v !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$' OR position('..' IN v) > 0
           OR split_part(v, '/', 1) <> p_org::text THEN
          PERFORM app.fail('MRS_INVALID', 'logo_path');
        END IF;
      END IF;
      v_set := v_set || jsonb_build_object(k, v);
    END LOOP;
    v_o.settings := v_set;
  END IF;

  UPDATE public.organizations o
     SET name_ar = v_o.name_ar, name_en = v_o.name_en, default_locale = v_o.default_locale,
         public_intake_enabled = v_o.public_intake_enabled, settings = v_o.settings
   WHERE o.id = p_org RETURNING * INTO v_o;
  RETURN jsonb_build_object('id', v_o.id, 'slug', v_o.slug, 'name_ar', v_o.name_ar, 'name_en', v_o.name_en,
                            'default_locale', v_o.default_locale, 'public_intake_enabled', v_o.public_intake_enabled,
                            'settings', v_o.settings, 'updated_at', v_o.updated_at);
END $$;
