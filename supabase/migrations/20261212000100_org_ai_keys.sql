-- =====================================================================
-- 20261212000100_org_ai_keys — an office may keep its own AI key; a warning + consent before a free Google key
-- (2026-11-23, owner request; branch owner/ui-polish)
--   Owner: «في موقع المشتركين لازم يكون في مكان للمفتاح إذا كان أحدهم يملك مفتاح خاص به». app.ai_provider_keys
--   (20261209000100) already carries org_id and public.ai_provider_keys(org) already returns the office key first, then
--   the platform's — so the reading path needs no change. This file adds what the office needs to manage its key, and
--   the owner's decision on Google's free tier: «الخدمة المجانية من جوجل قد تستخدم المستندات المرسلة لتحسين خدماتها،
--   وقد يطّلع عليها مراجعون لديها» — a Gemini key is saved as 'paid' or 'free'; a free one only with an explicit consent.
--   1. app.ai_provider_keys + key_tier ('paid' | 'free', NULL = not stated, the platform keys saved before), free_consent_by,
--      free_consent_at (CHECK: a free key always has its consent). app.ai_key_json + 'tier', 'free_consent_at'.
--   2. public.org_ai_keys(org) — org admins: per active provider, the office key (last 4 / tier / test, never the key),
--      whether the platform has a key, and the platform key's tier (so the page can warn about a free platform key).
--      public.org_ai_set_key(org, provider, key, tier, consent) / org_ai_clear_key(org, provider) — org admins: store /
--      replace / remove the office key in Vault (audit row with the office, provider and last 4 only).
--      public.platform_ai_set_key_tier(provider, tier, consent) — platform admins: the tier of the platform key.
--   3. service role only (the ai-extract Edge Function): public.ai_org_provider_key(org, provider) — the office's OWN key
--      (no fallback; the office's connection test), public.ai_record_org_key_test(org, provider, ok, note, models).
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS). Data: none changed; no key stored.
--   Down-path: DROP FUNCTION public.ai_record_org_key_test(uuid, text, boolean, text, jsonb),
--   public.ai_org_provider_key(uuid, text), public.platform_ai_set_key_tier(text, text, boolean),
--   public.org_ai_clear_key(uuid, text), public.org_ai_set_key(uuid, text, text, text, boolean), public.org_ai_keys(uuid);
--   re-create app.ai_key_json from 20261209000100; DELETE the office keys' Vault secrets (secret_id of rows with org_id)
--   and those rows; ALTER TABLE app.ai_provider_keys DROP CONSTRAINT ai_provider_keys_free_consent_chk, DROP COLUMN
--   free_consent_at, DROP COLUMN free_consent_by, DROP COLUMN key_tier; DELETE FROM public.schema_versions WHERE
--   version = '20261212000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261211000100') THEN
    RAISE EXCEPTION 'ORG AI KEYS preflight: apply site_profile first (schema_versions lacks 20261211000100)';
  END IF;
  IF to_regclass('app.ai_provider_keys') IS NULL OR to_regclass('vault.secrets') IS NULL THEN
    RAISE EXCEPTION 'ORG AI KEYS preflight: app.ai_provider_keys (ai_keys, 20261209000100) or Supabase Vault missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261212000100', 'org_ai_keys')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the tier of a key (Google's free tier needs a consent)
-- ---------------------------------------------------------------------
ALTER TABLE app.ai_provider_keys ADD COLUMN IF NOT EXISTS key_tier text CHECK (key_tier IS NULL OR key_tier IN ('paid', 'free'));
ALTER TABLE app.ai_provider_keys ADD COLUMN IF NOT EXISTS free_consent_by uuid;
ALTER TABLE app.ai_provider_keys ADD COLUMN IF NOT EXISTS free_consent_at timestamptz;
ALTER TABLE app.ai_provider_keys DROP CONSTRAINT IF EXISTS ai_provider_keys_free_consent_chk;
ALTER TABLE app.ai_provider_keys ADD CONSTRAINT ai_provider_keys_free_consent_chk
  CHECK (key_tier IS DISTINCT FROM 'free' OR (free_consent_by IS NOT NULL AND free_consent_at IS NOT NULL));
COMMENT ON COLUMN app.ai_provider_keys.key_tier IS 'paid | free (20261212000100). A free Google key may let Google use the documents sent to improve its services: saved only with the admin''s consent (free_consent_by / free_consent_at).';

CREATE OR REPLACE FUNCTION app.ai_key_json(k app.ai_provider_keys) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN k.id IS NULL THEN NULL ELSE jsonb_build_object('last4', k.key_last4, 'set_at', k.set_at,
    'set_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = k.set_by),
    'tested_at', k.tested_at, 'test_ok', k.test_ok, 'test_note', k.test_note, 'test_models', coalesce(k.test_models, '[]'::jsonb),
    'tier', k.key_tier, 'free_consent_at', k.free_consent_at) END
$$;

-- the tier rule shared by both scopes: tier 'free' only for Gemini (the only provider with a free API tier here) and
-- only with p_consent = true; NULL tier = 'paid' for a new key
CREATE OR REPLACE FUNCTION app.ai_check_tier(p_provider text, p_tier text, p_consent boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := coalesce(nullif(btrim(coalesce(p_tier, '')), ''), 'paid');
BEGIN
  IF v NOT IN ('paid', 'free') THEN PERFORM app.fail('MRS_INVALID', 'tier'); END IF;
  IF v = 'free' AND p_provider <> 'gemini' THEN PERFORM app.fail('MRS_INVALID', 'tier'); END IF;
  IF v = 'free' AND p_consent IS NOT TRUE THEN PERFORM app.fail('MRS_AI_FREE_CONSENT'); END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------
-- 2. the office settings («مفتاح الذكاء الاصطناعي الخاص بالمكتب») and the platform key's tier
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.org_ai_keys(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'provider', p.provider, 'sort', p.sort,
      'key', (SELECT app.ai_key_json(k) FROM app.ai_provider_keys k WHERE k.provider = p.provider AND k.org_id = p_org),
      'platform_key', EXISTS (SELECT 1 FROM app.ai_provider_keys k WHERE k.provider = p.provider AND k.org_id IS NULL),
      'platform_tier', (SELECT k.key_tier FROM app.ai_provider_keys k WHERE k.provider = p.provider AND k.org_id IS NULL))
      ORDER BY p.sort, p.provider) FROM app.ai_providers p WHERE p.is_active), '[]'::jsonb);
END $$;

-- store or replace the office key of a provider in Vault (same key rule as the platform: 20–400 printable, no spaces)
CREATE OR REPLACE FUNCTION public.org_ai_set_key(p_org uuid, p_provider text, p_key text, p_tier text DEFAULT NULL, p_consent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys; v_key text := btrim(coalesce(p_key, '')); v_sid uuid; v_last4 text; v_tier text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM app.ai_providers p WHERE p.provider = p_provider AND p.is_active) THEN PERFORM app.fail('MRS_INVALID', 'provider'); END IF;
  IF char_length(v_key) NOT BETWEEN 20 AND 400 OR v_key !~ '^[\x21-\x7E]+$' THEN PERFORM app.fail('MRS_INVALID', 'key'); END IF;
  v_tier := app.ai_check_tier(p_provider, p_tier, p_consent);
  v_last4 := right(v_key, 4);
  IF v_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN v_last4 := 'xxxx'; END IF;
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id = p_org FOR UPDATE;
  IF k.id IS NULL THEN
    v_sid := vault.create_secret(v_key, 'ai_key:org:' || p_org::text || ':' || p_provider, 'AI provider key (office) — set from the office settings');
    INSERT INTO app.ai_provider_keys (provider, org_id, secret_id, key_last4, set_by, key_tier, free_consent_by, free_consent_at)
    VALUES (p_provider, p_org, v_sid, v_last4, auth.uid(), v_tier,
            CASE WHEN v_tier = 'free' THEN auth.uid() END, CASE WHEN v_tier = 'free' THEN now() END)
    RETURNING * INTO k;
  ELSE
    PERFORM vault.update_secret(k.secret_id, v_key);
    UPDATE app.ai_provider_keys x SET key_last4 = v_last4, set_by = auth.uid(), set_at = now(), key_tier = v_tier,
           free_consent_by = CASE WHEN v_tier = 'free' THEN auth.uid() END, free_consent_at = CASE WHEN v_tier = 'free' THEN now() END,
           tested_at = NULL, test_ok = NULL, test_note = NULL, test_models = NULL
     WHERE x.id = k.id RETURNING * INTO k;
  END IF;
  v_key := NULL;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (p_org, 'ai_provider_keys', k.id::text, 'UPDATE', ARRAY['key'], NULL,
          jsonb_build_object('provider', p_provider, 'scope', 'office', 'last4', v_last4, 'tier', v_tier,
                             'free_consent', v_tier = 'free'), auth.uid(), auth.jwt() ->> 'role');
  RETURN app.ai_key_json(k);
END $$;

CREATE OR REPLACE FUNCTION public.org_ai_clear_key(p_org uuid, p_provider text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id = p_org FOR UPDATE;
  IF k.id IS NULL THEN RETURN jsonb_build_object('provider', p_provider, 'removed', false); END IF;
  DELETE FROM vault.secrets s WHERE s.id = k.secret_id;
  DELETE FROM app.ai_provider_keys x WHERE x.id = k.id;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (p_org, 'ai_provider_keys', k.id::text, 'DELETE', ARRAY['key'],
          jsonb_build_object('provider', p_provider, 'scope', 'office', 'last4', k.key_last4), NULL, auth.uid(), auth.jwt() ->> 'role');
  RETURN jsonb_build_object('provider', p_provider, 'removed', true);
END $$;

-- the platform page: the tier of the platform key (a free Google key only with the platform admin's consent)
CREATE OR REPLACE FUNCTION public.platform_ai_set_key_tier(p_provider text, p_tier text, p_consent boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k app.ai_provider_keys; v_tier text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  v_tier := app.ai_check_tier(p_provider, p_tier, p_consent);
  SELECT * INTO k FROM app.ai_provider_keys x WHERE x.provider = p_provider AND x.org_id IS NULL FOR UPDATE;
  IF k.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'key'); END IF;
  UPDATE app.ai_provider_keys x SET key_tier = v_tier,
         free_consent_by = CASE WHEN v_tier = 'free' THEN auth.uid() END, free_consent_at = CASE WHEN v_tier = 'free' THEN now() END
   WHERE x.id = k.id RETURNING * INTO k;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (NULL, 'ai_provider_keys', k.id::text, 'UPDATE', ARRAY['key_tier'], NULL,
          jsonb_build_object('provider', p_provider, 'scope', 'platform', 'tier', v_tier, 'free_consent', v_tier = 'free'), auth.uid(), auth.jwt() ->> 'role');
  RETURN app.ai_key_json(k);
END $$;

-- ---------------------------------------------------------------------
-- 3. the Edge Function (service role): the office's own key for its connection test, and the test result
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_org_provider_key(p_org uuid, p_provider text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  RETURN (SELECT d.decrypted_secret FROM app.ai_provider_keys k JOIN vault.decrypted_secrets d ON d.id = k.secret_id
           WHERE k.provider = p_provider AND k.org_id = p_org AND p_org IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION public.ai_record_org_key_test(p_org uuid, p_provider text, p_ok boolean, p_note text, p_models jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_models jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_org IS NULL OR p_ok IS NULL OR (p_note IS NOT NULL AND p_note !~ '^[a-z_]{1,40}$') THEN PERFORM app.fail('MRS_INVALID', 'test'); END IF;
  SELECT jsonb_agg(m ORDER BY m) INTO v_models FROM (
    SELECT DISTINCT e #>> '{}' m FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_models) = 'array' THEN p_models ELSE '[]'::jsonb END) e
     WHERE jsonb_typeof(e) = 'string' AND (e #>> '{}') ~ '^[a-z0-9][a-z0-9.-]{0,63}$' LIMIT 200) z;
  UPDATE app.ai_provider_keys k SET tested_at = now(), test_ok = p_ok, test_note = p_note, test_models = v_models
   WHERE k.provider = p_provider AND k.org_id = p_org;
END $$;

-- ---------------------------------------------------------------------
-- 4. privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.ai_key_json(app.ai_provider_keys), app.ai_check_tier(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.org_ai_keys(uuid), public.org_ai_set_key(uuid, text, text, text, boolean), public.org_ai_clear_key(uuid, text),
  public.platform_ai_set_key_tier(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.org_ai_keys(uuid), public.org_ai_set_key(uuid, text, text, text, boolean), public.org_ai_clear_key(uuid, text),
  public.platform_ai_set_key_tier(text, text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_org_provider_key(uuid, text), public.ai_record_org_key_test(uuid, text, boolean, text, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_org_provider_key(uuid, text), public.ai_record_org_key_test(uuid, text, boolean, text, jsonb) TO service_role;
