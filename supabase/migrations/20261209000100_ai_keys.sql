-- =====================================================================
-- 20261209000100_ai_keys — the AI providers' keys, model ids and prices managed from the platform page
-- (2026-11-22, owner request; branch owner/ui-reorg)
--   Owner: the keys are entered from the site's settings, not in code or in the hosting dashboard. Both kinds will exist:
--   the platform's keys (used for every office by default) and, later, an office's own key. This file builds the
--   platform keys; the table already carries org_id so an office key can be added without a new design.
--   1. app.ai_provider_keys — one row per (provider, scope): the Supabase Vault secret that holds the key (encrypted at
--      rest by Vault), its last 4 characters, who set it and when, and the last connection test. org_id NULL = the
--      platform's key. The key itself is NEVER in this table, in a return value to a browser, in the audit log or in a
--      log line.
--   2. public.platform_ai_providers() — platform admins: each provider, its model id, active flag, prices, whether a key
--      is saved (last 4 only) and the last test.
--      public.platform_ai_set_key(provider, key) / platform_ai_clear_key(provider) — platform admins: store / replace /
--      remove the platform key in Vault (audit row without the key).
--      public.platform_ai_save_provider(provider, {model, is_active, price_in, price_out}) — platform admins: the model id
--      asked for and its prices (app.ai_providers + app.ai_prices).
--   3. public.ai_provider_keys(org) — service_role only (the ai-extract Edge Function): the key to use per provider for an
--      organisation (its own key first — none yet — then the platform's). public.ai_record_key_test(provider, ok, note,
--      models) — service_role only: the result of the connection test the platform page asked the Edge Function for.
--   Needs Supabase Vault (Database → Extensions → supabase_vault; on by default in Supabase projects).
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE). Data: none changed; no key is stored by this file.
--   4. the in-place conversion keeps app.ai_provider_keys (app.convert_keep_tables re-created: the 20261206000100 body + this table).
--   Down-path: re-create app.convert_keep_tables (20261206000100 body); SELECT vault secret ids from app.ai_provider_keys and DELETE them from vault.secrets; DROP FUNCTION
--   public.ai_record_key_test(text, boolean, text, jsonb), public.ai_provider_keys(uuid),
--   public.platform_ai_save_provider(text, jsonb), public.platform_ai_clear_key(text), public.platform_ai_set_key(text, text),
--   public.platform_ai_providers(), app.ai_key_json(app.ai_provider_keys); DROP TABLE app.ai_provider_keys;
--   DELETE FROM public.schema_versions WHERE version = '20261209000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261208000100') THEN
    RAISE EXCEPTION 'AI KEYS preflight: apply ai_providers first (schema_versions lacks 20261208000100)';
  END IF;
  IF to_regclass('vault.secrets') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'AI KEYS preflight: Supabase Vault is not enabled (Database → Extensions → supabase_vault)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261209000100', 'ai_keys')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the keys (references to Vault secrets)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.ai_provider_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL REFERENCES app.ai_providers(provider) ON DELETE RESTRICT,
  org_id       uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,     -- NULL = the platform's key
  secret_id    uuid NOT NULL,                                                   -- vault.secrets.id
  key_last4    text NOT NULL CHECK (key_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  set_by       uuid,
  set_at       timestamptz NOT NULL DEFAULT now(),
  tested_at    timestamptz,
  test_ok      boolean,
  test_note    text CHECK (test_note IS NULL OR test_note ~ '^[a-z_]{1,40}$'),
  test_models  jsonb CHECK (test_models IS NULL OR (jsonb_typeof(test_models) = 'array' AND jsonb_array_length(test_models) <= 200
                            AND octet_length(test_models::text) <= 12000))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_keys_scope_uidx ON app.ai_provider_keys (provider, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));
COMMENT ON TABLE app.ai_provider_keys IS 'AI provider keys (20261209000100): a reference to the Supabase Vault secret that holds the key, its last 4 characters and the last connection test. org_id NULL = the platform key (all offices); an office key (org_id) is a later stage. The key is never stored here and never returned to a browser.';
ALTER TABLE app.ai_provider_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_provider_keys FROM PUBLIC, anon, authenticated, service_role;

-- the row as the platform page sees it (no secret id, no key)
CREATE OR REPLACE FUNCTION app.ai_key_json(k app.ai_provider_keys) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN k.id IS NULL THEN NULL ELSE jsonb_build_object('last4', k.key_last4, 'set_at', k.set_at,
    'set_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = k.set_by),
    'tested_at', k.tested_at, 'test_ok', k.test_ok, 'test_note', k.test_note, 'test_models', coalesce(k.test_models, '[]'::jsonb)) END
$$;

-- ---------------------------------------------------------------------
-- 2. the platform page
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_ai_providers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'provider', p.provider, 'model', p.model, 'is_active', p.is_active, 'sort', p.sort,
      'price_in', (SELECT x.input_usd_per_mtok FROM app.ai_prices x WHERE x.model = p.model),
      'price_out', (SELECT x.output_usd_per_mtok FROM app.ai_prices x WHERE x.model = p.model),
      'key', (SELECT app.ai_key_json(k) FROM app.ai_provider_keys k WHERE k.provider = p.provider AND k.org_id IS NULL))
      ORDER BY p.sort, p.provider) FROM app.ai_providers p), '[]'::jsonb);
END $$;

-- store or replace the platform key of a provider in Vault. The key: 20–400 printable characters without spaces.
CREATE OR REPLACE FUNCTION public.platform_ai_set_key(p_provider text, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys; v_key text := btrim(coalesce(p_key, '')); v_sid uuid; v_last4 text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM app.ai_providers p WHERE p.provider = p_provider) THEN PERFORM app.fail('MRS_INVALID', 'provider'); END IF;
  IF char_length(v_key) NOT BETWEEN 20 AND 400 OR v_key !~ '^[\x21-\x7E]+$' THEN PERFORM app.fail('MRS_INVALID', 'key'); END IF;
  v_last4 := right(v_key, 4);
  IF v_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN v_last4 := 'xxxx'; END IF;
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id IS NULL FOR UPDATE;
  IF k.id IS NULL THEN
    v_sid := vault.create_secret(v_key, 'ai_key:platform:' || p_provider, 'AI provider key (platform) — set from the platform page');
    INSERT INTO app.ai_provider_keys (provider, org_id, secret_id, key_last4, set_by) VALUES (p_provider, NULL, v_sid, v_last4, auth.uid())
    RETURNING * INTO k;
  ELSE
    PERFORM vault.update_secret(k.secret_id, v_key);
    UPDATE app.ai_provider_keys x SET key_last4 = v_last4, set_by = auth.uid(), set_at = now(),
           tested_at = NULL, test_ok = NULL, test_note = NULL, test_models = NULL
     WHERE x.id = k.id RETURNING * INTO k;
  END IF;
  v_key := NULL;
  -- the audit row names the provider and the last 4 characters only
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (NULL, 'ai_provider_keys', k.id::text, 'UPDATE', ARRAY['key'], NULL,
          jsonb_build_object('provider', p_provider, 'scope', 'platform', 'last4', v_last4), auth.uid(), auth.jwt() ->> 'role');
  RETURN app.ai_key_json(k);
END $$;

CREATE OR REPLACE FUNCTION public.platform_ai_clear_key(p_provider text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id IS NULL FOR UPDATE;
  IF k.id IS NULL THEN RETURN jsonb_build_object('provider', p_provider, 'removed', false); END IF;
  DELETE FROM vault.secrets s WHERE s.id = k.secret_id;
  DELETE FROM app.ai_provider_keys x WHERE x.id = k.id;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (NULL, 'ai_provider_keys', k.id::text, 'DELETE', ARRAY['key'],
          jsonb_build_object('provider', p_provider, 'scope', 'platform', 'last4', k.key_last4), NULL, auth.uid(), auth.jwt() ->> 'role');
  RETURN jsonb_build_object('provider', p_provider, 'removed', true);
END $$;

-- the model id asked for, on / off, and its prices (USD per million tokens; a price row per model id)
CREATE OR REPLACE FUNCTION public.platform_ai_save_provider(p_provider text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p app.ai_providers; v_old jsonb; v_in numeric; v_out numeric; v_model text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['model','is_active','price_in','price_out']);
  SELECT * INTO p FROM app.ai_providers x WHERE x.provider = p_provider FOR UPDATE;
  IF p.provider IS NULL THEN PERFORM app.fail('MRS_INVALID', 'provider'); END IF;
  v_old := to_jsonb(p);
  IF p_payload ? 'model' THEN
    v_model := btrim(coalesce(p_payload ->> 'model', ''));
    IF jsonb_typeof(p_payload -> 'model') <> 'string' OR v_model !~ '^[a-z0-9][a-z0-9.-]{0,63}$' THEN PERFORM app.fail('MRS_INVALID', 'model'); END IF;
    p.model := v_model;
  END IF;
  IF p_payload ? 'is_active' THEN
    IF jsonb_typeof(p_payload -> 'is_active') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'is_active'); END IF;
    p.is_active := (p_payload ->> 'is_active')::boolean;
  END IF;
  IF p_payload ? 'price_in' OR p_payload ? 'price_out' THEN
    -- both prices together (a missing one is NULL: IS DISTINCT FROM, not <>)
    IF jsonb_typeof(p_payload -> 'price_in') IS DISTINCT FROM 'number' OR jsonb_typeof(p_payload -> 'price_out') IS DISTINCT FROM 'number' THEN
      PERFORM app.fail('MRS_INVALID', 'price');
    END IF;
    v_in := (p_payload ->> 'price_in')::numeric; v_out := (p_payload ->> 'price_out')::numeric;
    IF v_in < 0 OR v_in > 1000 OR v_out < 0 OR v_out > 1000 OR v_in <> round(v_in, 4) OR v_out <> round(v_out, 4) THEN
      PERFORM app.fail('MRS_INVALID', 'price');
    END IF;
  END IF;
  UPDATE app.ai_providers x SET model = p.model, is_active = p.is_active, updated_at = now() WHERE x.provider = p.provider;
  IF v_in IS NOT NULL THEN
    INSERT INTO app.ai_prices (model, input_usd_per_mtok, output_usd_per_mtok) VALUES (p.model, v_in, v_out)
    ON CONFLICT (model) DO UPDATE SET input_usd_per_mtok = EXCLUDED.input_usd_per_mtok, output_usd_per_mtok = EXCLUDED.output_usd_per_mtok;
  END IF;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (NULL, 'ai_providers', p.provider, 'UPDATE', ARRAY(SELECT jsonb_object_keys(p_payload) ORDER BY 1), v_old,
          to_jsonb(p) || jsonb_build_object('price_in', v_in, 'price_out', v_out), auth.uid(), auth.jwt() ->> 'role');
  RETURN (SELECT e FROM jsonb_array_elements(public.platform_ai_providers()) e WHERE e ->> 'provider' = p.provider);
END $$;

-- ---------------------------------------------------------------------
-- 3. the Edge Function (service role)
-- ---------------------------------------------------------------------
-- {anthropic: key | null, openai: …, gemini: …} for an organisation: its own key first (a later stage), then the
-- platform's. Active providers only. p_org NULL = the platform keys (the connection test from the platform page).
CREATE OR REPLACE FUNCTION public.ai_provider_keys(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  RETURN coalesce((SELECT jsonb_object_agg(p.provider, (
      SELECT d.decrypted_secret FROM app.ai_provider_keys k JOIN vault.decrypted_secrets d ON d.id = k.secret_id
       WHERE k.provider = p.provider AND (k.org_id = p_org OR k.org_id IS NULL)
       ORDER BY (k.org_id IS NULL) LIMIT 1))
    FROM app.ai_providers p WHERE p.is_active), '{}'::jsonb);
END $$;

-- the connection test's result (ok, a fixed note code, the model ids the provider listed)
CREATE OR REPLACE FUNCTION public.ai_record_key_test(p_provider text, p_ok boolean, p_note text, p_models jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_models jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_ok IS NULL OR (p_note IS NOT NULL AND p_note !~ '^[a-z_]{1,40}$') THEN PERFORM app.fail('MRS_INVALID', 'test'); END IF;
  -- model ids only (the same pattern as app.ai_providers.model), at most 200
  SELECT jsonb_agg(m ORDER BY m) INTO v_models FROM (
    SELECT DISTINCT e #>> '{}' m FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_models) = 'array' THEN p_models ELSE '[]'::jsonb END) e
     WHERE jsonb_typeof(e) = 'string' AND (e #>> '{}') ~ '^[a-z0-9][a-z0-9.-]{0,63}$' LIMIT 200) z;
  UPDATE app.ai_provider_keys k SET tested_at = now(), test_ok = p_ok, test_note = p_note, test_models = v_models
   WHERE k.provider = p_provider AND k.org_id IS NULL;
END $$;

-- ---------------------------------------------------------------------
-- 4. the in-place conversion (20261115000100) keeps the keys: configuration, not test data. app.convert_keep_tables =
--    the 20261206000100 body + app.ai_provider_keys (a table with org_id must be classified, or the conversion refuses)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.convert_keep_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.branches', 'public.memberships', 'public.org_counters', 'public.org_usage_counters',
    'public.msg_channels', 'public.msg_settings', 'public.msg_auto_reply_policies', 'public.msg_templates',
    'public.msg_instructions', 'public.daftra_connections', 'public.daftra_item_links', 'public.document_requirements',
    'public.org_subscriptions', 'public.subscription_events', 'app.ai_settings',
    'public.org_service_items',                                                                         -- LEGACY
    'public.tx_stage_sets', 'public.tx_stage_steps',                                                    -- owner stages
    'public.storage_gate_ports',                                                                        -- storage gate (20261206000100)
    'app.ai_provider_keys',                                                                            -- AI keys (20261209000100): configuration, kept
    -- append-only / log tables
    'public.audit_log', 'public.report_exports', 'app.ai_usage', 'public.operational_alert_runs', 'public.client_errors'
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 5. privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.ai_key_json(app.ai_provider_keys), app.convert_keep_tables() FROM PUBLIC, anon, authenticated, service_role;
-- platform admin RPCs (the functions check app.is_platform_admin)
REVOKE ALL ON FUNCTION public.platform_ai_providers(), public.platform_ai_set_key(text, text), public.platform_ai_clear_key(text),
  public.platform_ai_save_provider(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_ai_providers(), public.platform_ai_set_key(text, text), public.platform_ai_clear_key(text),
  public.platform_ai_save_provider(text, jsonb) TO authenticated;
-- Edge Function RPCs: service_role only
REVOKE ALL ON FUNCTION public.ai_provider_keys(uuid), public.ai_record_key_test(text, boolean, text, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_provider_keys(uuid), public.ai_record_key_test(text, boolean, text, jsonb) TO service_role;
