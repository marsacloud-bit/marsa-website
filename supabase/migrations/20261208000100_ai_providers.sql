-- =====================================================================
-- 20261208000100_ai_providers — AI reading with several providers, tried in the order each organisation chooses
-- (2026-11-21, owner request; branch owner/ui-reorg)
--   Owner: start with Gemini or OpenAI (keys he holds), Claude when needed; if one fails or is slow, the next one reads.
--   CLAUDE.md «القراءة بالذكاء الاصطناعي»: one reading layer, providers behind one interface, the order is a setting,
--   the next provider on a technical error / timeout / an answer that fails the checks; provider, model, time and
--   whether a fallback ran are recorded with every reading.
--   1. app.ai_providers — the providers the platform can call (anthropic · openai · gemini) and the model id each is
--      asked for. Platform-wide (the SQL Editor tunes the model ids, like app.ai_prices). Seeded; re-run keeps tuned rows.
--      The keys are Edge Function secrets (one per provider, set by the owner), never in the database.
--   2. app.ai_settings + provider_order text[] (the organisation's order, default {anthropic}: unchanged behaviour) and
--      consent_providers text[] (the providers the admin's last consent named). Existing consents named Anthropic only.
--   3. app.ai_provider_chain(org) → [{provider, model}] = provider_order ∩ active providers ∩ consented providers;
--      public.ai_access + 'providers' (the Edge Function tries them in this order; a provider without its key is skipped).
--   4. public.ai_save_settings + key provider_order (1–3 distinct active providers). A provider the last consent did
--      not name needs consent_ack = true in the same call (document contents are then sent to that provider too);
--      off → on stamps the consent for the whole order. ai_settings_json + provider_order, consent_providers, providers
--      (the active list with their models) and usage by provider.
--   5. app.ai_usage + provider, call_meta (per attempt: provider, model, outcome, ms). public.ai_settle (same signature)
--      stores them from the extra keys of p_attempts ({model, input_tokens, output_tokens, provider?, outcome?, ms?}).
--   6. app.ai_is_engine(engine): an AI reading's engine is Claude's name (app.ai_model()) or a model of app.ai_providers /
--      app.ai_prices; app.tg_document_extractions_before re-created with it (body otherwise identical to 20261119000100).
--   Prices: an OpenAI / Gemini model without its app.ai_prices row is priced at the highest row (conservative, as
--   before); add the real list prices with INSERT … ON CONFLICT from the SQL Editor.
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING keeps tuned rows and settings).
--   Data: none changed except consent_providers = {anthropic} on rows whose consent was given (it named Anthropic).
--   Down-path: re-paste the 20261114000100 / 20261119000100 bodies of the re-created functions; DROP FUNCTION
--   app.ai_provider_chain(uuid), app.ai_is_engine(text); ALTER TABLE app.ai_usage DROP COLUMN call_meta, DROP COLUMN
--   provider; ALTER TABLE app.ai_settings DROP COLUMN consent_providers, DROP COLUMN provider_order; DROP TABLE
--   app.ai_providers; DELETE FROM public.schema_versions WHERE version = '20261208000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261207000100') THEN
    RAISE EXCEPTION 'AI PROVIDERS preflight: apply driver_classes first (schema_versions lacks 20261207000100)';
  END IF;
  IF to_regclass('app.ai_settings') IS NULL OR to_regclass('app.ai_usage') IS NULL OR to_regclass('app.ai_prices') IS NULL
     OR to_regprocedure('app.ai_usage_source_ok(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'AI PROVIDERS preflight: ai_documents / legacy_docs missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261208000100', 'ai_providers')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the providers (platform settings)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.ai_providers (
  provider    text PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  model       text NOT NULL CHECK (model ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  is_active   boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.ai_providers IS 'AI reading providers the ai-extract Edge Function can call (20261208000100) and the model id each is asked for. Platform-wide; tuned from the SQL Editor (UPDATE app.ai_providers SET model = … WHERE provider = …). The Edge Function calls a provider only when its key secret is set. anthropic always uses the model the function is built for (app.ai_model()).';
-- the model ids are a starting point: confirm them against each provider's model list before switching the order
INSERT INTO app.ai_providers (provider, model, sort) VALUES
  ('anthropic', 'claude-opus-5-5', 1),
  ('openai',    'gpt-6.2-astra',   2),
  ('gemini',    'gemini-3.8-flash', 3)
ON CONFLICT (provider) DO NOTHING;
ALTER TABLE app.ai_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_providers FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. the organisation's order and the providers its consent named
-- ---------------------------------------------------------------------
ALTER TABLE app.ai_settings ADD COLUMN IF NOT EXISTS provider_order text[] NOT NULL DEFAULT ARRAY['anthropic']::text[];
ALTER TABLE app.ai_settings ADD COLUMN IF NOT EXISTS consent_providers text[];
COMMENT ON COLUMN app.ai_settings.provider_order IS 'AI reading providers in the order they are tried (20261208000100): app.ai_providers codes, 1–3, distinct. Set by public.ai_save_settings.';
COMMENT ON COLUMN app.ai_settings.consent_providers IS 'The providers named by the admin''s last consent (document contents are sent to them). A provider outside it is never called (app.ai_provider_chain).';
-- the consents given before this file named Anthropic only
UPDATE app.ai_settings s SET consent_providers = ARRAY['anthropic']::text[]
 WHERE s.consent_ack_at IS NOT NULL AND s.consent_providers IS NULL;

-- the ledger: which provider answered, and every attempt (set by public.ai_settle, section 5)
ALTER TABLE app.ai_usage ADD COLUMN IF NOT EXISTS provider text CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_]{1,30}$');
ALTER TABLE app.ai_usage ADD COLUMN IF NOT EXISTS call_meta jsonb CHECK (call_meta IS NULL OR (jsonb_typeof(call_meta) = 'array'
  AND jsonb_array_length(call_meta) <= 10 AND octet_length(call_meta::text) <= 4000));
COMMENT ON COLUMN app.ai_usage.provider IS 'The provider whose answer was used (20261208000100); NULL = none answered / an older row.';
COMMENT ON COLUMN app.ai_usage.call_meta IS 'Per attempt (20261208000100): [{provider, model, outcome, ms}] — outcome ok / refused / truncated / bad_output / upstream_* / not_configured / internal. More than one entry = a fallback ran. Codes and numbers only.';

-- settings with defaults (no row = off, 50 / day, 20 USD / month, Claude only)
CREATE OR REPLACE FUNCTION app.ai_settings_of(p_org uuid) RETURNS app.ai_settings
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v app.ai_settings;
BEGIN
  SELECT * INTO v FROM app.ai_settings s WHERE s.org_id = p_org;
  IF v.org_id IS NULL THEN
    v.org_id := p_org; v.enabled := false; v.daily_request_cap := 50; v.monthly_budget_usd := 20;
    v.provider_order := ARRAY['anthropic']::text[];                                                    -- PROVIDERS
  END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------
-- 3. the chain the Edge Function tries
-- ---------------------------------------------------------------------
-- [{provider, model}] in the organisation's order: active providers its consent named (empty when AI is off)
CREATE OR REPLACE FUNCTION app.ai_provider_chain(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('provider', p.provider,
           'model', CASE WHEN p.provider = 'anthropic' THEN app.ai_model() ELSE p.model END) ORDER BY o.n), '[]'::jsonb)
    FROM app.ai_settings_of(p_org) s
    CROSS JOIN LATERAL unnest(s.provider_order) WITH ORDINALITY AS o(code, n)
    JOIN app.ai_providers p ON p.provider = o.code AND p.is_active
   WHERE s.enabled AND o.code = ANY (coalesce(s.consent_providers, ARRAY[]::text[]))
$$;

-- the engine name of an AI reading: Claude's (app.ai_model()) or a provider / priced model id. SECURITY DEFINER: the
-- extraction trigger runs as the inserting staff member, who cannot read app.ai_providers / app.ai_prices.
CREATE OR REPLACE FUNCTION app.ai_is_engine(p_engine text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_engine IS NOT NULL AND (p_engine = app.ai_model()
    OR EXISTS (SELECT 1 FROM app.ai_providers p WHERE p.model = p_engine)
    OR EXISTS (SELECT 1 FROM app.ai_prices p WHERE p.model = p_engine))
$$;

-- ai_access(p_org) — as 20261114000100 + 'providers' (the chain)
CREATE OR REPLACE FUNCTION public.ai_access(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s app.ai_settings; v_today int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  s := app.ai_settings_of(p_org);
  SELECT count(*)::int INTO v_today FROM app.ai_usage u
   WHERE u.org_id = p_org AND u.purpose = 'doc_extract' AND u.created_at >= app.ai_day_start();
  RETURN jsonb_build_object('org_id', p_org, 'enabled', s.enabled, 'can_use', s.enabled, 'model', app.ai_model(),
    'provider', 'anthropic', 'daily_request_cap', s.daily_request_cap, 'today_requests', v_today,
    'daily_remaining', greatest(s.daily_request_cap - v_today, 0),
    'providers', app.ai_provider_chain(p_org));                                                        -- PROVIDERS
END $$;

-- ---------------------------------------------------------------------
-- 4. settings: the order, the consent per provider, usage by provider
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ai_usage_json(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    -- the daily cap counts document readings only
    'today_requests', (SELECT count(*)::int FROM app.ai_usage u WHERE u.org_id = p_org AND u.purpose = 'doc_extract'
                         AND u.created_at >= app.ai_day_start()),
    'month', (SELECT jsonb_build_object(
                'requests', count(*)::int,
                'ok', count(*) FILTER (WHERE u.status = 'ok')::int,
                'refused', count(*) FILTER (WHERE u.status = 'refused')::int,
                'error', count(*) FILTER (WHERE u.status = 'error')::int,
                'reserved', count(*) FILTER (WHERE u.status = 'reserved')::int,
                'input_tokens', coalesce(sum(u.input_tokens), 0)::bigint,
                'output_tokens', coalesce(sum(u.output_tokens), 0)::bigint,
                'cost_usd', round(coalesce(sum(u.cost_usd) FILTER (WHERE u.status <> 'reserved'), 0), 4),
                'held_usd', round(coalesce(sum(u.reserved_usd) FILTER (WHERE u.status = 'reserved'), 0), 4),
                'by_purpose', coalesce((SELECT jsonb_object_agg(z.purpose, z.n)
                                          FROM (SELECT x.purpose, count(*)::int n FROM app.ai_usage x
                                                 WHERE x.org_id = p_org AND x.created_at >= app.ai_month_start()
                                                 GROUP BY x.purpose) z), '{}'::jsonb),
                -- PROVIDERS: the readings each provider answered this month, and how many needed a fallback
                'by_provider', coalesce((SELECT jsonb_object_agg(z.provider, z.n)
                                           FROM (SELECT x.provider, count(*)::int n FROM app.ai_usage x
                                                  WHERE x.org_id = p_org AND x.created_at >= app.ai_month_start()
                                                    AND x.status = 'ok' AND x.provider IS NOT NULL
                                                  GROUP BY x.provider) z), '{}'::jsonb),
                'fell_back', (SELECT count(*)::int FROM app.ai_usage x
                               WHERE x.org_id = p_org AND x.created_at >= app.ai_month_start()
                                 AND jsonb_array_length(coalesce(x.call_meta, '[]'::jsonb)) > 1))
                FROM app.ai_usage u WHERE u.org_id = p_org AND u.created_at >= app.ai_month_start()),
    'month_start', app.ai_month_start())
$$;

CREATE OR REPLACE FUNCTION app.ai_settings_json(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'org_id', s.org_id, 'enabled', s.enabled, 'consent_ack_at', s.consent_ack_at, 'consent_ack_by', s.consent_ack_by,
    'consent_version', s.consent_version, 'daily_request_cap', s.daily_request_cap,
    'monthly_budget_usd', s.monthly_budget_usd, 'updated_at', s.updated_at,
    'exists', EXISTS (SELECT 1 FROM app.ai_settings x WHERE x.org_id = p_org),
    'model', app.ai_model(), 'provider', 'anthropic',
    -- PROVIDERS
    'provider_order', to_jsonb(s.provider_order), 'consent_providers', to_jsonb(coalesce(s.consent_providers, ARRAY[]::text[])),
    'providers', (SELECT coalesce(jsonb_agg(jsonb_build_object('provider', p.provider,
                    'model', CASE WHEN p.provider = 'anthropic' THEN app.ai_model() ELSE p.model END) ORDER BY p.sort, p.provider), '[]'::jsonb)
                    FROM app.ai_providers p WHERE p.is_active),
    'usage', app.ai_usage_json(p_org))
    FROM app.ai_settings_of(p_org) s
$$;

-- ai_save_settings(p_org, {enabled, consent_ack, daily_request_cap, monthly_budget_usd, provider_order}) — org admin
-- (aal2). As 20261114000100, + provider_order: 1–3 distinct active providers. While on (or switching on), a provider the
-- last consent did not name needs consent_ack = true in the same call; the consent then names the whole order.
CREATE OR REPLACE FUNCTION public.ai_save_settings(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v app.ai_settings; v_old jsonb; v_new jsonb; v_b boolean; v_i int; v_n numeric; v_changed text[];
        v_order text[]; v_ack boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['enabled','consent_ack','daily_request_cap','monthly_budget_usd','provider_order']);
  INSERT INTO app.ai_settings (org_id, updated_by) VALUES (p_org, auth.uid()) ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v FROM app.ai_settings s WHERE s.org_id = p_org FOR UPDATE;
  v_old := to_jsonb(v);

  IF p_payload ? 'daily_request_cap' THEN
    v_i := app.msg_rint(p_payload, 'daily_request_cap', 1, 1000);
    IF v_i IS NULL THEN PERFORM app.fail('MRS_INVALID', 'daily_request_cap'); END IF;
    v.daily_request_cap := v_i;
  END IF;
  IF p_payload ? 'monthly_budget_usd' THEN
    v_n := app.msg_rnum(p_payload, 'monthly_budget_usd', 0, 10000);
    IF v_n IS NULL OR v_n <> round(v_n, 2) THEN PERFORM app.fail('MRS_INVALID', 'monthly_budget_usd'); END IF;
    v.monthly_budget_usd := v_n;
  END IF;
  IF p_payload ? 'consent_ack' AND app.msg_rbool(p_payload, 'consent_ack') IS NULL THEN
    PERFORM app.fail('MRS_INVALID', 'consent_ack');
  END IF;
  v_ack := app.msg_rbool(p_payload, 'consent_ack') IS TRUE;
  -- PROVIDERS: the order — 1–3 distinct codes of active providers, kept as given
  IF p_payload ? 'provider_order' THEN
    IF jsonb_typeof(p_payload -> 'provider_order') <> 'array' OR jsonb_array_length(p_payload -> 'provider_order') NOT BETWEEN 1 AND 3
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload -> 'provider_order') e WHERE jsonb_typeof(e) <> 'string') THEN
      PERFORM app.fail('MRS_INVALID', 'provider_order');
    END IF;
    SELECT array_agg(e #>> '{}' ORDER BY n) INTO v_order FROM jsonb_array_elements(p_payload -> 'provider_order') WITH ORDINALITY AS t(e, n);
    IF (SELECT count(DISTINCT x) FROM unnest(v_order) x) <> cardinality(v_order)
       OR EXISTS (SELECT 1 FROM unnest(v_order) x WHERE NOT EXISTS (SELECT 1 FROM app.ai_providers p WHERE p.provider = x AND p.is_active)) THEN
      PERFORM app.fail('MRS_INVALID', 'provider_order');
    END IF;
    v.provider_order := v_order;
  END IF;
  IF p_payload ? 'enabled' THEN
    v_b := app.msg_rbool(p_payload, 'enabled');
    IF v_b IS NULL THEN PERFORM app.fail('MRS_INVALID', 'enabled'); END IF;
    IF v_b AND NOT v.enabled THEN
      -- off → on: the explicit consent (document contents and inbox message text are sent to the providers of the
      -- order) is required now
      IF NOT v_ack THEN PERFORM app.fail('MRS_REQUIRED', 'ai_consent'); END IF;
      v.consent_ack_at := now(); v.consent_ack_by := auth.uid(); v.consent_version := 'ai-doc-inbox-v2';
      v.consent_providers := v.provider_order;                                                        -- PROVIDERS
    END IF;
    v.enabled := v_b;
  END IF;
  -- PROVIDERS: while on, a provider the consent did not name needs the consent again (it then names the whole order)
  IF v.enabled AND NOT (v.provider_order <@ coalesce(v.consent_providers, ARRAY[]::text[])) THEN
    IF NOT v_ack THEN PERFORM app.fail('MRS_REQUIRED', 'ai_consent'); END IF;
    v.consent_ack_at := now(); v.consent_ack_by := auth.uid(); v.consent_version := 'ai-doc-inbox-v2';
    v.consent_providers := v.provider_order;
  END IF;

  UPDATE app.ai_settings s SET enabled = v.enabled, consent_ack_at = v.consent_ack_at, consent_ack_by = v.consent_ack_by,
         consent_version = v.consent_version, daily_request_cap = v.daily_request_cap,
         monthly_budget_usd = v.monthly_budget_usd, provider_order = v.provider_order,
         consent_providers = v.consent_providers, updated_by = auth.uid(), updated_at = now()
   WHERE s.org_id = p_org
  RETURNING to_jsonb(s) INTO v_new;
  SELECT array_agg(k ORDER BY k) INTO v_changed FROM jsonb_object_keys(v_new) k
   WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k NOT IN ('updated_at','updated_by');
  IF v_changed IS NOT NULL THEN
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
    VALUES (p_org, 'ai_settings', p_org::text, 'UPDATE', v_changed, v_old, v_new, auth.uid(), auth.jwt() ->> 'role');
  END IF;
  RETURN app.ai_settings_json(p_org);
END $$;

-- ---------------------------------------------------------------------
-- 5. the settle: which provider answered, and every attempt
-- ---------------------------------------------------------------------
-- ai_settle — as 20261114000100 (same signature and pricing). PROVIDERS: an attempt may carry provider, outcome and ms
-- (ai-extract, 20261208000100); they are kept in call_meta, and the provider of the last 'ok' attempt in provider.
CREATE OR REPLACE FUNCTION public.ai_settle(p_reservation uuid, p_input_tokens int, p_output_tokens int, p_status text,
                                            p_model text DEFAULT NULL, p_attempts jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u app.ai_usage; v_model text; v_cost numeric := 0; v_in bigint := 0; v_out bigint := 0; v_status text;
        a jsonb; v_am text; v_ai bigint; v_ao bigint;
        v_meta jsonb := '[]'::jsonb; v_prov text; v_ok text; v_oc text; v_ms numeric;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_status IS NULL OR p_status NOT IN ('ok','refused','error','unknown') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF p_input_tokens IS NULL OR p_input_tokens NOT BETWEEN 0 AND 50000000 THEN PERFORM app.fail('MRS_INVALID', 'input_tokens'); END IF;
  IF p_output_tokens IS NULL OR p_output_tokens NOT BETWEEN 0 AND 50000000 THEN PERFORM app.fail('MRS_INVALID', 'output_tokens'); END IF;
  IF p_attempts IS NOT NULL AND (jsonb_typeof(p_attempts) <> 'array' OR jsonb_array_length(p_attempts) NOT BETWEEN 1 AND 10) THEN
    PERFORM app.fail('MRS_INVALID', 'attempts');
  END IF;
  SELECT * INTO u FROM app.ai_usage x WHERE x.id = p_reservation;
  IF u.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'reservation'); END IF;
  PERFORM 1 FROM app.ai_settings x WHERE x.org_id = u.org_id FOR UPDATE;          -- same order as ai_reserve
  SELECT * INTO u FROM app.ai_usage x WHERE x.id = p_reservation FOR UPDATE;
  IF u.status <> 'reserved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'settled'); END IF;
  v_model := coalesce(nullif(btrim(p_model), ''), u.model);
  IF v_model !~ '^[a-z0-9][a-z0-9.-]{0,63}$' THEN PERFORM app.fail('MRS_INVALID', 'model'); END IF;

  IF p_attempts IS NULL THEN
    v_in := p_input_tokens; v_out := p_output_tokens;
    v_cost := app.ai_cost_usd(v_model, p_input_tokens, p_output_tokens);
  ELSE
    FOR a IN SELECT e FROM jsonb_array_elements(p_attempts) e LOOP
      IF jsonb_typeof(a) <> 'object' OR jsonb_typeof(a -> 'input_tokens') <> 'number' OR jsonb_typeof(a -> 'output_tokens') <> 'number'
         OR (a ? 'model' AND jsonb_typeof(a -> 'model') NOT IN ('string','null')) THEN
        PERFORM app.fail('MRS_INVALID', 'attempts');
      END IF;
      v_am := coalesce(nullif(btrim(a ->> 'model'), ''), u.model);
      IF v_am !~ '^[a-z0-9][a-z0-9.-]{0,63}$' THEN PERFORM app.fail('MRS_INVALID', 'attempts'); END IF;
      IF (a ->> 'input_tokens')::numeric <> trunc((a ->> 'input_tokens')::numeric) OR (a ->> 'output_tokens')::numeric <> trunc((a ->> 'output_tokens')::numeric)
         OR (a ->> 'input_tokens')::numeric NOT BETWEEN 0 AND 50000000 OR (a ->> 'output_tokens')::numeric NOT BETWEEN 0 AND 50000000 THEN
        PERFORM app.fail('MRS_INVALID', 'attempts');
      END IF;
      v_ai := (a ->> 'input_tokens')::bigint; v_ao := (a ->> 'output_tokens')::bigint;
      v_in := v_in + v_ai; v_out := v_out + v_ao;
      v_cost := v_cost + app.ai_cost_usd(v_am, v_ai::int, v_ao::int);
      -- PROVIDERS: the attempt's provider / outcome / time (codes and numbers only; anything else is dropped)
      v_prov := CASE WHEN jsonb_typeof(a -> 'provider') = 'string' AND (a ->> 'provider') ~ '^[a-z][a-z0-9_]{1,30}$' THEN a ->> 'provider' END;
      IF v_prov IS NOT NULL THEN
        v_oc := CASE WHEN jsonb_typeof(a -> 'outcome') = 'string' AND (a ->> 'outcome') ~ '^[a-z_]{1,30}$' THEN a ->> 'outcome' END;
        v_ms := CASE WHEN jsonb_typeof(a -> 'ms') = 'number' AND (a ->> 'ms')::numeric BETWEEN 0 AND 3600000 THEN round((a ->> 'ms')::numeric) END;
        v_meta := v_meta || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('provider', v_prov, 'model', v_am, 'outcome', v_oc, 'ms', v_ms)));
        IF v_oc = 'ok' THEN v_ok := v_prov; END IF;
      END IF;
    END LOOP;
    IF v_in > 50000000 OR v_out > 50000000 THEN PERFORM app.fail('MRS_INVALID', 'attempts'); END IF;
  END IF;

  v_status := CASE WHEN p_status = 'unknown' THEN 'error' ELSE p_status END;
  IF p_status = 'unknown' THEN v_cost := greatest(v_cost, u.reserved_usd); END IF;
  UPDATE app.ai_usage x SET status = v_status, model = v_model, input_tokens = v_in::int, output_tokens = v_out::int,
         cost_usd = v_cost, unknown_outcome = (p_status = 'unknown'),
         provider = CASE WHEN v_status = 'ok' THEN v_ok END,                                            -- PROVIDERS
         call_meta = CASE WHEN jsonb_array_length(v_meta) > 0 THEN v_meta END                            -- PROVIDERS
   WHERE x.id = p_reservation;
  RETURN jsonb_build_object('id', u.id, 'status', v_status, 'unknown_outcome', p_status = 'unknown', 'model', v_model,
    'input_tokens', v_in, 'output_tokens', v_out, 'cost_usd', v_cost);
END $$;

-- ---------------------------------------------------------------------
-- 6. an AI reading saved by another provider
-- ---------------------------------------------------------------------
-- tg_document_extractions_before (20261119000100). PROVIDERS: the AI engine check uses app.ai_is_engine (Claude's
-- engine name or an OpenAI / Gemini model id); the body is otherwise identical.
CREATE OR REPLACE FUNCTION app.tg_document_extractions_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_doc public.documents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.is_api_caller() THEN
      NEW.created_by := auth.uid();
      NEW.created_at := now();
      NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
      NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
      -- AI: the engine name and the usage link go together, and the link must be the caller's own 'ok' reading
      IF NEW.ai_usage_id IS NOT NULL OR app.ai_is_engine(NEW.engine) THEN                                    -- PROVIDERS
        IF NEW.ai_usage_id IS NULL OR NOT app.ai_is_engine(NEW.engine)                                       -- PROVIDERS
           OR NOT app.ai_usage_claimable(NEW.ai_usage_id, NEW.org_id) THEN
          PERFORM app.fail('MRS_INVALID', 'ai_usage_id');
        END IF;
      END IF;
      -- DOCS: the ai-doc-v3 detail belongs to an AI reading only
      IF NEW.ai_detail IS NOT NULL AND NEW.ai_usage_id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'ai_detail'); END IF;   -- DOCS
      -- REVIEW: an ai-doc-v3 reading is saved under the hash of the bytes Claude read (bound by the Edge Function)
      IF NEW.ai_detail IS NOT NULL AND NOT app.ai_usage_source_ok(NEW.ai_usage_id, NEW.source_sha256) THEN               -- DOCS
        PERFORM app.fail('MRS_INVALID', 'source_sha256');                                                                -- DOCS
      END IF;                                                                                                            -- DOCS
    END IF;
    -- saved already reviewed (edited before the first save) → stamp the reviewer
    IF NEW.review_status <> 'unreviewed' THEN
      NEW.reviewed_by := coalesce(auth.uid(), NEW.reviewed_by);
      NEW.reviewed_at := now();
    END IF;
  ELSE
    IF app.is_api_caller() THEN
      IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'voided_at'); END IF;
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
        'id','org_id','source_name','source_sha256','source_mime','source_size','source_pages',
        'engine','languages','mean_confidence','raw_text','extracted_fields','qr_payload',
        'reviewed_by','reviewed_at','voided_by','created_by','created_at','ai_usage_id','ai_detail']);    -- DOCS
      IF OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
        PERFORM app.fail('MRS_IMMUTABLE', 'transaction_id');
      END IF;
      IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
        PERFORM app.fail('MRS_IMMUTABLE', 'document_id');
      END IF;
    END IF;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status
       OR NEW.reviewed_fields IS DISTINCT FROM OLD.reviewed_fields
       OR NEW.line_items IS DISTINCT FROM OLD.line_items
       OR NEW.review_note IS DISTINCT FROM OLD.review_note
       OR NEW.doc_type IS DISTINCT FROM OLD.doc_type THEN
      NEW.reviewed_by := coalesce(auth.uid(), NEW.reviewed_by);
      NEW.reviewed_at := now();
    END IF;
    IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
      NEW.voided_by := auth.uid();
      NEW.voided_at := now();
    END IF;
  END IF;

  -- the attached original must be a live document of the same transaction
  IF NEW.document_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = NEW.document_id;
    IF v_doc.id IS NULL OR NEW.transaction_id IS NULL
       OR v_doc.transaction_id IS DISTINCT FROM NEW.transaction_id OR v_doc.voided_at IS NOT NULL THEN
      PERFORM app.fail('MRS_INVALID', 'document_id');
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 7. privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.ai_provider_chain(uuid), app.ai_settings_of(uuid), app.ai_usage_json(uuid), app.ai_settings_json(uuid)
FROM PUBLIC, anon, authenticated, service_role;
-- called from the (SECURITY INVOKER) extraction trigger, i.e. as the inserting staff member: authenticated only
REVOKE EXECUTE ON FUNCTION app.ai_is_engine(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.ai_is_engine(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION app.tg_document_extractions_before() FROM PUBLIC, anon, authenticated;
-- staff / org admin RPCs (as 20261114000100)
REVOKE ALL ON FUNCTION public.ai_access(uuid), public.ai_save_settings(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_access(uuid), public.ai_save_settings(uuid, jsonb) TO authenticated;
-- Edge Function RPC: service_role only
REVOKE ALL ON FUNCTION public.ai_settle(uuid, int, int, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_settle(uuid, int, int, text, text, jsonb) TO service_role;
