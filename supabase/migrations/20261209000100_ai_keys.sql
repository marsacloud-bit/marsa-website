-- =====================================================================
-- 20261209000100_ai_keys — the AI providers' keys, model ids and prices managed from the platform page
-- (2026-11-22, owner request; branch owner/ui-reorg)
--   Owner: the keys are entered from the site's settings, not in code or in the hosting dashboard. Both kinds will exist:
--   the platform's keys (used for every office by default) and, later, an office's own key. This file builds the
--   platform keys; the table already carries org_id so an office key can be added without a new design.
--   1. app.ai_provider_keys — one row per (provider, scope): the Supabase Vault secret that holds the key (encrypted at
--      rest by Vault), its last 4 characters, who set it and when, and the last connection test. org_id NULL = the
--      platform's key. The key itself is NEVER in this table, in a return value to a browser, in the audit log or in a
--      log line. A row without a secret (secret_id NULL) = the key was deleted on the platform page: that provider then
--      has NO key — the provider's Edge Function secret is not used for it
--      either. Only a provider with no row at all may still use its Edge Function secret (the setup before this page).
--   2. public.platform_ai_providers() — platform admins: each provider, its model id (anthropic: app.ai_model(), locked),
--      active flag, prices, whether a key is saved (last 4 only), the key source (vault / env / none) and the last test.
--      public.platform_ai_set_key(provider, key) / platform_ai_clear_key(provider) — platform admins: store / replace /
--      remove the platform key in Vault (audit row without the key). Before a Vault secret is created, any orphan secret
--      of the same name is deleted (the name is unique in Vault).
--      public.platform_ai_save_provider(provider, {model, is_active, price_in, price_out}) — platform admins: the model id
--      asked for and its prices (app.ai_providers + app.ai_prices). A model id another provider already asks for is
--      refused (MRS_CONFLICT model_taken: the prices are keyed by the model id); anthropic's model is app.ai_model()
--      (MRS_INVALID model_locked otherwise); a price must be above 0 (MRS_INVALID price).
--   3. public.ai_provider_keys(org) — service_role only (the ai-extract Edge Function): per provider {source: 'vault',
--      key} | {source: 'none'} (deleted on the page / Vault secret missing: no key at all) | {source: 'env'} (no row: the
--      Edge Function secret may be used) for an organisation (its own key first — none yet — then the platform's; org
--      NULL = the platform's, every provider, for the connection test). public.ai_record_key_test(provider, ok, note,
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
  secret_id    uuid,                                                            -- vault.secrets.id; NULL = deleted on the page (no key, no secret fallback)
  key_last4    text CHECK (key_last4 IS NULL OR key_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  set_by       uuid,
  set_at       timestamptz NOT NULL DEFAULT now(),
  tested_at    timestamptz,
  test_ok      boolean,
  test_note    text CHECK (test_note IS NULL OR test_note ~ '^[a-z_]{1,40}$'),
  test_models  jsonb CHECK (test_models IS NULL OR (jsonb_typeof(test_models) = 'array' AND jsonb_array_length(test_models) <= 200
                            AND octet_length(test_models::text) <= 12000)),
  CONSTRAINT ai_provider_keys_secret_last4_chk CHECK ((secret_id IS NULL) = (key_last4 IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_keys_scope_uidx ON app.ai_provider_keys (provider, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));
COMMENT ON TABLE app.ai_provider_keys IS 'AI provider keys (20261209000100): a reference to the Supabase Vault secret that holds the key, its last 4 characters and the last connection test. org_id NULL = the platform key (all offices); an office key (org_id) is a later stage. secret_id NULL = the key was deleted on the platform page: the provider has no key and the Edge Function secret is not used for it (DELETE the row from the SQL Editor to allow the secret again). The key is never stored here and never returned to a browser.';
ALTER TABLE app.ai_provider_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_provider_keys FROM PUBLIC, anon, authenticated, service_role;

-- the row as the platform page sees it (no secret id, no key)
CREATE OR REPLACE FUNCTION app.ai_key_json(k app.ai_provider_keys) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN k.id IS NULL OR k.secret_id IS NULL THEN NULL ELSE jsonb_build_object('last4', k.key_last4, 'set_at', k.set_at,
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
  -- anthropic always asks for app.ai_model() (the model the function is built for): shown, priced and locked as such.
  -- key_source: 'vault' (a key saved here), 'none' (deleted here, or its Vault secret is missing: no key, the Edge
  -- Function secret is NOT used), 'env' (never saved here: the Edge Function secret is used if one is set)
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'provider', p.provider, 'model', m.model, 'model_locked', p.provider = 'anthropic', 'is_active', p.is_active, 'sort', p.sort,
      'price_in', (SELECT x.input_usd_per_mtok FROM app.ai_prices x WHERE x.model = m.model),
      'price_out', (SELECT x.output_usd_per_mtok FROM app.ai_prices x WHERE x.model = m.model),
      'key', app.ai_key_json(k),
      'key_source', CASE WHEN k.id IS NULL THEN 'env'
                         WHEN k.secret_id IS NOT NULL AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = k.secret_id) THEN 'vault'
                         ELSE 'none' END)
      ORDER BY p.sort, p.provider)
    FROM app.ai_providers p
    CROSS JOIN LATERAL (SELECT CASE WHEN p.provider = 'anthropic' THEN app.ai_model() ELSE p.model END AS model) m
    LEFT JOIN app.ai_provider_keys k ON k.provider = p.provider AND k.org_id IS NULL), '[]'::jsonb);
END $$;

-- store or replace the platform key of a provider in Vault. The key: 20–400 printable characters without spaces.
CREATE OR REPLACE FUNCTION public.platform_ai_set_key(p_provider text, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys; v_key text := btrim(coalesce(p_key, '')); v_sid uuid; v_last4 text;
        v_name text := 'ai_key:platform:' || coalesce(p_provider, '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM app.ai_providers p WHERE p.provider = p_provider) THEN PERFORM app.fail('MRS_INVALID', 'provider'); END IF;
  IF char_length(v_key) NOT BETWEEN 20 AND 400 OR v_key !~ '^[\x21-\x7E]+$' THEN PERFORM app.fail('MRS_INVALID', 'key'); END IF;
  v_last4 := right(v_key, 4);
  IF v_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN v_last4 := 'xxxx'; END IF;
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id IS NULL FOR UPDATE;
  IF k.secret_id IS NOT NULL AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = k.secret_id) THEN
    -- replace: the same Vault secret holds the new key
    PERFORM vault.update_secret(k.secret_id, v_key);
    v_sid := k.secret_id;
  ELSE
    -- a new secret (no row, a row deleted on the page, or a row whose secret is gone). An orphan secret of the same name
    -- (a row removed outside this page, an interrupted earlier save) would make create_secret fail: the name is unique.
    DELETE FROM vault.secrets s WHERE s.name = v_name;
    v_sid := vault.create_secret(v_key, v_name, 'AI provider key (platform) — set from the platform page');
  END IF;
  IF k.id IS NULL THEN
    INSERT INTO app.ai_provider_keys (provider, org_id, secret_id, key_last4, set_by) VALUES (p_provider, NULL, v_sid, v_last4, auth.uid())
    RETURNING * INTO k;
  ELSE
    UPDATE app.ai_provider_keys x SET secret_id = v_sid, key_last4 = v_last4, set_by = auth.uid(), set_at = now(),
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

-- delete the platform key: the Vault secret (and any orphan of the same name) is removed and the row stays without a
-- secret, so the provider has no key at all — the Edge Function secret is not used for it either (the dialog says so).
-- A provider that had no row gets one (the secret fallback stops too).
CREATE OR REPLACE FUNCTION public.platform_ai_clear_key(p_provider text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys; v_name text := 'ai_key:platform:' || coalesce(p_provider, ''); v_had boolean; v_new boolean := false;
        v_last4 text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM app.ai_providers p WHERE p.provider = p_provider) THEN PERFORM app.fail('MRS_INVALID', 'provider'); END IF;
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id IS NULL FOR UPDATE;
  v_had := k.secret_id IS NOT NULL AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = k.secret_id);
  v_last4 := k.key_last4;
  DELETE FROM vault.secrets s WHERE s.id = k.secret_id OR s.name = v_name;
  IF k.id IS NULL THEN
    INSERT INTO app.ai_provider_keys (provider, org_id, secret_id, key_last4, set_by) VALUES (p_provider, NULL, NULL, NULL, auth.uid())
    RETURNING * INTO k;
    v_new := true;
  ELSIF k.secret_id IS NOT NULL THEN
    UPDATE app.ai_provider_keys x SET secret_id = NULL, key_last4 = NULL, set_by = auth.uid(), set_at = now(),
           tested_at = NULL, test_ok = NULL, test_note = NULL, test_models = NULL
     WHERE x.id = k.id RETURNING * INTO k;
  ELSE
    RETURN jsonb_build_object('provider', p_provider, 'removed', false, 'key_source', 'none');
  END IF;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (NULL, 'ai_provider_keys', k.id::text, CASE WHEN v_new THEN 'INSERT' ELSE 'DELETE' END, ARRAY['key'],
          CASE WHEN v_new THEN NULL ELSE jsonb_build_object('provider', p_provider, 'scope', 'platform', 'last4', v_last4) END,
          CASE WHEN v_new THEN jsonb_build_object('provider', p_provider, 'scope', 'platform', 'key_source', 'none') END,
          auth.uid(), auth.jwt() ->> 'role');
  RETURN jsonb_build_object('provider', p_provider, 'removed', v_had, 'key_source', 'none');
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
    -- anthropic always asks for the model the function is built for
    IF p.provider = 'anthropic' AND v_model <> app.ai_model() THEN PERFORM app.fail('MRS_INVALID', 'model_locked'); END IF;
    p.model := v_model;
  END IF;
  IF p.provider = 'anthropic' THEN p.model := app.ai_model(); END IF;
  -- one model id per provider: the prices (app.ai_prices) are keyed by the model id
  IF EXISTS (SELECT 1 FROM app.ai_providers x WHERE x.model = p.model AND x.provider <> p.provider)
     OR (p.provider <> 'anthropic' AND p.model = app.ai_model()) THEN
    PERFORM app.fail('MRS_CONFLICT', 'model_taken');
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
    -- above 0 (a 0 price would make every reading free for the monthly budget), at most 1000, 4 decimals
    IF v_in <= 0 OR v_in > 1000 OR v_out <= 0 OR v_out > 1000 OR v_in <> round(v_in, 4) OR v_out <> round(v_out, 4) THEN
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
-- {anthropic: {source, key?}, openai: …, gemini: …} for an organisation: its own key row first (a later stage), then
-- the platform's. source 'vault' + key = the saved key; 'none' = deleted on the page or its Vault secret is missing (no
-- key: the Edge Function must NOT use its secret); 'env' = no row (the Edge Function secret may be used). Active
-- providers only; p_org NULL = the platform keys of every provider (the connection test from the platform page).
CREATE OR REPLACE FUNCTION public.ai_provider_keys(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  RETURN coalesce((SELECT jsonb_object_agg(p.provider,
      CASE WHEN k.id IS NULL THEN jsonb_build_object('source', 'env')
           WHEN coalesce(d.decrypted_secret, '') = '' THEN jsonb_build_object('source', 'none')
           ELSE jsonb_build_object('source', 'vault', 'key', d.decrypted_secret) END)
    FROM app.ai_providers p
    LEFT JOIN LATERAL (SELECT x.id, x.secret_id FROM app.ai_provider_keys x
                        WHERE x.provider = p.provider AND (x.org_id = p_org OR x.org_id IS NULL)
                        ORDER BY (x.org_id IS NULL) LIMIT 1) k ON true
    LEFT JOIN vault.decrypted_secrets d ON d.id = k.secret_id
   WHERE p.is_active OR p_org IS NULL), '{}'::jsonb);
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
