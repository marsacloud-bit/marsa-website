-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261112000100 — deployment environment: ONE database-wide setting 'staging' | 'production'
-- instead of the 'staging' literals in the SQL (supabase/production/README.md). Builds on G5b (20261111000100).
--
-- Production is a NEW, separate Supabase project: the install file of scripts/build-production-sql.py (every migration,
-- never seed.sql, then SELECT public.set_deploy_environment('production') — SQL Editor only — and checks). The default
-- stays 'staging', so applying this file on staging changes nothing (health_check, new orgs, public_track: 'staging').
--   P. preflight (G5b applied) + schema_versions row
--   0. setting      app.deploy_settings (single row, default 'staging'; one-way to 'production', no delete, no
--                   truncate; a direct staging → production UPDATE gets the same refusals as the switch) —
--                   in schema app: not reachable through the API, no grant to any API role
--   1. helpers      app.deploy_environment() (SECURITY DEFINER read of the row; 'staging' when missing)
--                   app.is_demo_org(public.organizations) (the seed.sql org slug, or settings.demo = true)
--   2. orgs         BEFORE INSERT trigger: environment := deployment environment (never the caller's value);
--                   in production a demo org is refused, on INSERT (seed.sql fails there) and on UPDATE OF slug /
--                   settings (settings.demo = true later). CHECK unchanged (staging, production)
--   3. re-created   (bodies copied from the latest migration that defines each, changed minimally, marked "ENV")
--                   public.health_check          (20261102000300) 'environment' = deployment environment
--                   public.platform_create_org   (20261103000200) environment + settings {"staging": true} only on staging
--                   public.public_track          (20261102000200) 'environment' = deployment environment
--   4. switch       public.set_deploy_environment(text): SQL Editor only (postgres). staging → production once;
--                   production → staging refused; production refused while a demo org or any 'staging' org exists
--   5. privileges   set_deploy_environment / app helpers: no API role; re-created functions re-asserted identically
-- Unchanged on purpose: organizations.environment stays immutable (trg_guard); existing orgs keep their value;
-- submit_service_request / my_context / platform_list_orgs already report o.environment.
-- Re-runnable (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING keeps a switched row).
-- Re-pasting 20261102000200, 20261102000300 or 20261103000200 after this file restores a hard-coded 'staging' body:
-- re-paste this file right after (supabase/production/post_install_checks.sql reports it: env_body_reverted).
-- Down-path (staging only): DROP FUNCTION public.set_deploy_environment(text); re-paste the three bodies above.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261111000100') THEN
    RAISE EXCEPTION 'ENV preflight: apply G5b first (schema_versions lacks 20261111000100 g5b_daftra_live)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.environment NOT IN ('staging','production')) THEN
    RAISE EXCEPTION 'ENV preflight: organizations holds an unknown environment';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261112000100', 'deploy_env')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. deployment setting (one row; written only by set_deploy_environment)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.deploy_settings (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),        -- exactly one row
  environment text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  switched_at timestamptz,                                         -- when it became 'production'
  switched_by text CHECK (char_length(switched_by) <= 63),         -- session_user of the SQL Editor
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.deploy_settings IS 'Deployment environment of THIS database (staging | production). One row; staging → production once, never back. Changed only by public.set_deploy_environment() from the SQL Editor.';
-- re-run keeps a switched row ('production' is never reset to the default)
INSERT INTO app.deploy_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE app.deploy_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.deploy_settings FROM PUBLIC, anon, authenticated, service_role;
-- no policies: only SECURITY DEFINER functions (owner) read it

-- one-way + no delete / truncate, also against a direct UPDATE / DELETE / TRUNCATE from the SQL Editor
-- (a TRUNCATE would bring back the 'staging' default: deploy_environment() and the re-run INSERT below)
CREATE OR REPLACE FUNCTION app.tg_deploy_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN PERFORM app.fail('MRS_IMMUTABLE', 'deploy_settings'); END IF;
  IF OLD.environment = 'production' AND NEW.environment <> 'production' THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'production_is_one_way');
  END IF;
  -- staging → production by a direct UPDATE: the same refusals as set_deploy_environment
  IF OLD.environment = 'staging' AND NEW.environment = 'production' THEN
    IF EXISTS (SELECT 1 FROM public.organizations o WHERE app.is_demo_org(o)) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'demo_org_present');
    END IF;
    IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.environment = 'staging') THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'staging_orgs_present');
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_deploy_settings_guard ON app.deploy_settings;
CREATE TRIGGER trg_deploy_settings_guard BEFORE UPDATE OR DELETE ON app.deploy_settings
  FOR EACH ROW EXECUTE FUNCTION app.tg_deploy_settings_guard();
DROP TRIGGER IF EXISTS trg_deploy_settings_truncate ON app.deploy_settings;
CREATE TRIGGER trg_deploy_settings_truncate BEFORE TRUNCATE ON app.deploy_settings
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_deploy_settings_guard();

-- ---------------------------------------------------------------------
-- 1. helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.deploy_environment() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.environment FROM app.deploy_settings s WHERE s.id), 'staging')
$$;

-- the staging seed org (supabase/seed.sql) or an org explicitly flagged demo
CREATE OR REPLACE FUNCTION app.is_demo_org(o public.organizations) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT o.slug = 'blue-sea' OR coalesce(o.settings ->> 'demo', '') = 'true'
$$;

-- ---------------------------------------------------------------------
-- 2. organizations: a new org always gets the deployment environment; no demo org in production
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_org_environment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_env text := app.deploy_environment();
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.environment := v_env; END IF;    -- UPDATE: environment stays immutable (trg_guard)
  IF v_env = 'production' AND app.is_demo_org(NEW) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'demo_org_in_production');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_org_environment ON public.organizations;
CREATE TRIGGER trg_org_environment BEFORE INSERT OR UPDATE OF slug, settings ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_environment();

COMMENT ON TABLE public.organizations IS 'Tenant (مؤسسة). environment = the deployment environment when the org was created (app.deploy_environment(), set by trg_org_environment); immutable afterwards.';

-- ---------------------------------------------------------------------
-- 3. re-created functions (latest bodies, minimal changes marked "ENV")
-- ---------------------------------------------------------------------
-- health_check (20261102000300; deliberately anon: no auth.uid() check, no tenant data)
CREATE OR REPLACE FUNCTION public.health_check() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('ok', true, 'db_time', now(),
                            'schema_version', (SELECT max(v.version) FROM public.schema_versions v),
                            'environment', app.deploy_environment())                                  -- ENV
$$;

-- platform_create_org (20261103000200)
CREATE OR REPLACE FUNCTION public.platform_create_org(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key    uuid;
  v_replay jsonb;
  v_slug   text;
  v_name   text;
  v_prefix text;
  v_locale text;
  v_email  text;
  v_br     jsonb;
  v_bf     jsonb;
  v_org    uuid;
  v_branch uuid;
  v_inv    record;
  v_res    jsonb;
  v_env    text := app.deploy_environment();                                                      -- ENV
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['slug','name_ar','name_en','ref_prefix','default_locale','branch',
                                         'admin_email','idempotencyKey']);
  v_key := app.idem_key_from(p_payload);
  v_replay := app.idem_begin('platform_create_org', v_key, p_payload);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_slug := lower(app.ptext(p_payload, 'slug', 40, true));
  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' THEN PERFORM app.fail('MRS_INVALID', 'slug'); END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = v_slug) THEN PERFORM app.fail('MRS_INVALID', 'slug_taken'); END IF;
  v_name := app.ptext(p_payload, 'name_ar', 160, true);
  IF char_length(v_name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
  v_prefix := upper(app.ptext(p_payload, 'ref_prefix', 5, true));
  IF v_prefix !~ '^[A-Z]{2,5}$' THEN PERFORM app.fail('MRS_INVALID', 'ref_prefix'); END IF;
  v_locale := coalesce(app.ptext(p_payload, 'default_locale', 2), 'ar');
  IF v_locale NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'default_locale'); END IF;
  v_email := lower(app.ptext(p_payload, 'admin_email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'admin_email'); END IF;
  v_br := p_payload -> 'branch';
  IF v_br IS NULL OR jsonb_typeof(v_br) <> 'object' THEN PERFORM app.fail('MRS_REQUIRED', 'branch'); END IF;
  PERFORM app.only_keys(v_br, ARRAY['code','name_ar','name_en','city']);
  IF NOT (v_br ? 'code') THEN PERFORM app.fail('MRS_REQUIRED', 'code'); END IF;
  IF NOT (v_br ? 'name_ar') THEN PERFORM app.fail('MRS_REQUIRED', 'name_ar'); END IF;
  v_bf := app.branch_fields(v_br);

  -- ENV: environment = the deployment environment (also forced by trg_org_environment), never taken from the payload
  INSERT INTO public.organizations (slug, name_ar, name_en, ref_prefix, environment, default_locale, settings)
  VALUES (v_slug, v_name, app.ptext(p_payload, 'name_en', 160), v_prefix, v_env, v_locale,
          CASE WHEN v_env = 'staging' THEN '{"staging": true}'::jsonb ELSE '{}'::jsonb END)
  RETURNING id INTO v_org;
  INSERT INTO public.branches (org_id, code, name_ar, name_en, city)
  VALUES (v_org, v_bf ->> 'code', v_bf ->> 'name_ar', v_bf ->> 'name_en', v_bf ->> 'city')
  RETURNING id INTO v_branch;
  -- G3.10: default document requirements (the org admin edits them later)
  PERFORM app.seed_document_requirements(v_org);
  SELECT * INTO v_inv FROM app.create_invitation(v_org, v_email, 'admin', NULL, NULL);

  -- the stored replay copy never holds the token
  v_res := jsonb_build_object('org_id', v_org, 'slug', v_slug, 'branch_id', v_branch, 'invitation_id', v_inv.id,
                              'email', v_email, 'expires_at', v_inv.expires_at,
                              'token', NULL, 'accept_path', NULL, 'token_shown', true);
  PERFORM app.idem_finish('platform_create_org', v_key, v_res);
  RETURN v_res || jsonb_build_object('token', v_inv.token, 'accept_path', 'login.html?invite=' || v_inv.token,
                                     'token_shown', false);
END $$;

-- public_track (20261102000200): a suspended organization's requests / transactions are not trackable
CREATE OR REPLACE FUNCTION public.public_track(p_ref text, p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ref  text := upper(btrim(coalesce(p_ref, '')));
  v_tok  text := lower(btrim(coalesce(p_token, '')));
  v_hash text;
  v_req  public.service_requests;
  v_tx   public.transactions;
  v_res  jsonb;
  v_tl   jsonb;
BEGIN
  IF v_ref !~ '^[A-Z]{2,5}-[0-9]{4}-[0-9]{6,}$' OR v_tok !~ '^[0-9a-f]{64}$' THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;
  v_hash := app.hash_token(v_tok);

  SELECT * INTO v_req FROM public.service_requests r WHERE r.ref = v_ref AND r.tracking_token_hash = v_hash LIMIT 1;
  IF v_req.id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.request_id = v_req.id;
  ELSE
    SELECT * INTO v_tx FROM public.transactions t WHERE t.ref = v_ref AND t.tracking_token_hash = v_hash LIMIT 1;
    IF v_tx.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = coalesce(v_req.org_id, v_tx.org_id) AND o.is_active) THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;

  v_res := jsonb_build_object('ref', v_ref, 'environment', app.deploy_environment());              -- ENV

  IF v_req.id IS NOT NULL THEN
    v_res := v_res || jsonb_build_object(
      'kind', 'request',
      'request', jsonb_build_object(
        'ref', v_req.ref, 'status', v_req.status,
        'status_label_ar', (SELECT s.label_ar FROM public.status_labels s WHERE s.domain = 'request_status' AND s.code = v_req.status),
        'status_label_en', (SELECT s.label_en FROM public.status_labels s WHERE s.domain = 'request_status' AND s.code = v_req.status),
        'direction', v_req.direction, 'mode', v_req.mode,
        'created_at', v_req.created_at, 'reviewed_at', v_req.reviewed_at));
  ELSE
    v_res := v_res || jsonb_build_object('kind', 'transaction');
  END IF;

  IF v_tx.id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('status', e.to_status, 'label_ar', s.label_ar, 'label_en', s.label_en,
                                                 'at', e.created_at) ORDER BY e.created_at, e.id), '[]'::jsonb)
      INTO v_tl
      FROM public.transaction_events e
      JOIN public.status_labels s ON s.domain = 'operational_status' AND s.code = e.to_status
     WHERE e.transaction_id = v_tx.id AND e.visible_to_client AND e.event_type IN ('created','operational_status');
    v_res := v_res || jsonb_build_object('transaction', jsonb_build_object(
      'ref', v_tx.ref,
      'operation', v_tx.operation, 'mode', v_tx.mode,
      'operational_status', v_tx.operational_status,
      'status_label_ar', (SELECT s.label_ar FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'status_label_en', (SELECT s.label_en FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'stage_index', (SELECT s.sort FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'stage_total', 10,
      'status_changed_at', v_tx.status_changed_at,
      'containers', (SELECT jsonb_build_object(
                        'total', count(*),
                        'returned', count(*) FILTER (WHERE c.return_status IN ('returned_verified','waived')))
                     FROM public.containers c WHERE c.transaction_id = v_tx.id),
      'timeline', v_tl));
  END IF;
  RETURN v_res;
END $$;

-- ---------------------------------------------------------------------
-- 4. the switch (SQL Editor only: no API role can execute it, and a request with JWT claims is refused too)
-- ---------------------------------------------------------------------
-- SELECT public.set_deploy_environment('production');  → {environment, from, changed, switched_at}
CREATE OR REPLACE FUNCTION public.set_deploy_environment(p_env text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_env text := lower(btrim(coalesce(p_env, '')));
  v     app.deploy_settings;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'sql_editor_only');
  END IF;
  IF v_env NOT IN ('staging','production') THEN PERFORM app.fail('MRS_INVALID', 'environment'); END IF;
  INSERT INTO app.deploy_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v FROM app.deploy_settings s WHERE s.id FOR UPDATE;
  IF v.environment = v_env THEN
    RETURN jsonb_build_object('environment', v.environment, 'from', v.environment, 'changed', false, 'switched_at', v.switched_at);
  END IF;
  IF v.environment = 'production' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'production_is_one_way'); END IF;
  -- staging → production: an empty tenant list, or only orgs that are neither demo nor created as 'staging'
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE app.is_demo_org(o)) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'demo_org_present');
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.environment = 'staging') THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'staging_orgs_present');
  END IF;
  UPDATE app.deploy_settings s SET environment = 'production', switched_at = now(), switched_by = left(session_user::text, 63)
   WHERE s.id RETURNING * INTO v;
  RETURN jsonb_build_object('environment', v.environment, 'from', 'staging', 'changed', true, 'switched_at', v.switched_at);
END $$;

-- ---------------------------------------------------------------------
-- 5. privileges
-- ---------------------------------------------------------------------
-- app helpers / triggers: called by SECURITY DEFINER code (owner) only
REVOKE EXECUTE ON FUNCTION app.deploy_environment(), app.is_demo_org(public.organizations),
  app.tg_org_environment(), app.tg_deploy_settings_guard()
FROM PUBLIC, anon, authenticated, service_role;
-- the switch: SQL Editor (postgres) only — not even the Edge Functions' service_role
REVOKE EXECUTE ON FUNCTION public.set_deploy_environment(text) FROM PUBLIC, anon, authenticated, service_role;

-- re-created functions (as in 20261031000400 / 20261102000300 / 20261102000200: health_check + public_track visitors;
-- platform_create_org authenticated)
REVOKE EXECUTE ON FUNCTION public.health_check(), public.public_track(text, text), public.platform_create_org(jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_check(), public.public_track(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_create_org(jsonb) TO authenticated;
