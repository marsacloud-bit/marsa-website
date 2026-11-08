-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261114000100 — AI document reading (قراءة المستندات بالذكاء الاصطناعي) with
-- Claude (Anthropic API, model claude-opus-5-5) through the Edge Function supabase/functions/ai-extract.
-- Builds on the public anti-spam file (20261113000100). Document contents leave Supabase (they are sent to Anthropic
-- for processing), so the feature is OFF for every organization until an org admin (aal2) switches it on with an
-- explicit consent (ack timestamp + user, like msg_channels.provider_terms_ack). Staff only; never anon / clients.
--   P. preflight (public_antispam applied, document_extractions present) + schema_versions row
--   0. tables       (schema app: not reachable through the API, no grant to any API role, RLS on, no policies)
--                   app.ai_prices    USD per million tokens per model (seeded: claude-opus-5-5 4 / 20; the server-side
--                                    fallback models claude-opus-5 and claude-opus-4-8 5 / 25) — kept on re-run
--                   app.ai_settings  one row per org: enabled (false), consent_ack_at / _by / consent_version,
--                                    daily_request_cap (50), monthly_budget_usd (20). ONE switch, ONE consent and ONE
--                                    budget for every Claude use of the org: document reading (ai-extract) and the
--                                    inbox model provider (inbox-sync, purpose 'inbox'; consent version ai-doc-inbox-v2
--                                    covers message text too)
--                   app.ai_usage     the usage ledger, append-only: one row per Claude request (doc_extract) or per
--                                    inbox AI job (inbox, no user), inserted by ai_reserve (status 'reserved', held
--                                    estimate) and settled ONCE by ai_settle (ok / refused / error / unknown, tokens and
--                                    cost per attempt from app.ai_prices; unknown = charged the held amount). No DELETE,
--                                    no other UPDATE.
--   1. helpers      app.ai_model, app.ai_day_start / app.ai_month_start (Asia/Riyadh), app.ai_settings_of,
--                   app.ai_cost_usd, app.ai_usage_json, app.ai_settings_json, app.ai_usage_claimable,
--                   app.tg_ai_usage_guard (append-only / one settle)
--   2. extractions  public.document_extractions + ai_usage_id (FK app.ai_usage, unique: one reading = one row);
--                   re-created (bodies from 20261101000100, changed minimally, marked "AI"):
--                   app.extraction_field_keys  + vessel, voyage, port_of_loading, port_of_discharge, shipper, consignee
--                   app.tg_document_extractions_before  an API insert with engine 'claude-opus-5-5' (or an ai_usage_id)
--                                    needs an 'ok' doc_extract reading of the same org by the same user; ai_usage_id immutable
--   3. RPCs         staff (authenticated): public.ai_access(org)                       → enabled / can_use / today
--                   org admin (aal2):      public.ai_get_settings(org)                 → settings + usage summary
--                                          public.ai_save_settings(org, payload)       → enable needs consent_ack
--                   service_role only:     public.ai_reserve(org, user, purpose, est)  → reservation id (caps, budget)
--                                          public.ai_settle(id, in, out, status, model, attempts) → cost
--   4. privileges   app objects: no API role; staff / admin RPCs: authenticated; reserve / settle: service_role
-- Caps: the daily cap counts the org's document readings (doc_extract) since 00:00 Asia/Riyadh (reserved, ok,
-- refused, error) — inbox jobs, which external senders trigger, do not use it up; the monthly budget compares settled
-- cost + held estimates of open reservations (both purposes) + the new estimate with monthly_budget_usd (calendar
-- month, Asia/Riyadh). A reservation older than 15 minutes is settled 'error' at its held
-- estimate by the next ai_reserve of the org (the Edge Function wall clock is 150 s). Reserve / settle serialize on
-- the org's settings row (FOR UPDATE).
-- The Anthropic API key never reaches the database: it is an Edge Function secret, read by ai-extract/index.ts only.
-- No document content is stored by this file: ai_usage holds counts and money only.
-- Re-runnable (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING keeps tuned prices and settings).
-- Re-pasting 20261101000100 after this file restores the trigger / field keys without the AI rule: re-paste this file
-- right after.
-- Down-path (staging only): re-paste 20261101000100 §1 + §3 bodies, then ALTER TABLE public.document_extractions
-- DROP COLUMN ai_usage_id; DROP FUNCTION public.ai_access(uuid), public.ai_get_settings(uuid),
-- public.ai_save_settings(uuid, jsonb), public.ai_reserve(uuid, uuid, text, numeric),
-- public.ai_settle(uuid, int, int, text, text, jsonb) and the app.ai_* helpers; DROP TABLE app.ai_usage, app.ai_settings,
-- app.ai_prices.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261113000100') THEN
    RAISE EXCEPTION 'AI preflight: apply public_antispam first (schema_versions lacks 20261113000100 public_antispam)';
  END IF;
  IF to_regclass('public.document_extractions') IS NULL OR to_regprocedure('app.extraction_fields_ok(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'AI preflight: public.document_extractions missing (apply 20261101000100 document_extractions)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261114000100', 'ai_documents')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. tables (schema app; only SECURITY DEFINER functions (owner) read / write them)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.ai_prices (
  model                 text PRIMARY KEY CHECK (model ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  input_usd_per_mtok    numeric(10,4) NOT NULL CHECK (input_usd_per_mtok >= 0),
  output_usd_per_mtok   numeric(10,4) NOT NULL CHECK (output_usd_per_mtok >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.ai_prices IS 'Anthropic list prices (USD per million tokens) used for the usage cost ESTIMATE. claude-opus-5-5 is the model the Edge Function asks for; claude-opus-5 / claude-opus-4-8 are the server-side refusal fallbacks it may be served by. An unknown model is priced at the highest row (conservative). Tune with UPDATE from the SQL Editor; re-running the migration keeps tuned rows.';
INSERT INTO app.ai_prices (model, input_usd_per_mtok, output_usd_per_mtok) VALUES
  ('claude-opus-5-5', 4, 20),
  ('claude-opus-5',   5, 25),
  ('claude-opus-4-8', 5, 25)
ON CONFLICT (model) DO NOTHING;
ALTER TABLE app.ai_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_prices FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app.ai_settings (
  org_id              uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  enabled             boolean NOT NULL DEFAULT false,
  -- the admin's explicit consent that document contents are sent to Anthropic (set when enabling; kept as the record
  -- of the last consent when disabled; re-enabling asks again)
  consent_ack_at      timestamptz,
  consent_ack_by      uuid,
  consent_version     text CHECK (consent_version ~ '^[a-z0-9-]{1,40}$'),
  daily_request_cap   int NOT NULL DEFAULT 50 CHECK (daily_request_cap BETWEEN 1 AND 1000),
  monthly_budget_usd  numeric(10,2) NOT NULL DEFAULT 20 CHECK (monthly_budget_usd BETWEEN 0 AND 10000),
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_settings_consent_chk CHECK (NOT enabled OR (consent_ack_at IS NOT NULL AND consent_ack_by IS NOT NULL))
);
COMMENT ON TABLE app.ai_settings IS 'AI document reading per organization. Off by default (no row = off). Enabled only by an org admin (aal2) through public.ai_save_settings with consent_ack (document contents are sent to Anthropic). Caps: daily_request_cap requests per Asia/Riyadh day, monthly_budget_usd estimated cost per calendar month.';
ALTER TABLE app.ai_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_settings FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app.ai_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id        uuid,                                                                         -- NULL only for inbox jobs
  purpose        text NOT NULL CHECK (purpose IN ('doc_extract','inbox')),
  model          text NOT NULL CHECK (model ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  status         text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','ok','refused','error')),
  input_tokens   int NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 50000000),
  output_tokens  int NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 50000000),
  reserved_usd   numeric(12,6) NOT NULL CHECK (reserved_usd > 0 AND reserved_usd <= 50),    -- held while 'reserved'
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),                      -- estimate from app.ai_prices
  stale          boolean NOT NULL DEFAULT false,                                              -- settled by the 15-min sweep
  unknown_outcome boolean NOT NULL DEFAULT false,                                             -- settled 'unknown': held amount charged
  created_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  CONSTRAINT ai_usage_settled_chk CHECK ((status = 'reserved') = (settled_at IS NULL)),
  CONSTRAINT ai_usage_user_chk CHECK (purpose = 'inbox' OR user_id IS NOT NULL)
);
-- re-run over an earlier copy of this file: the same columns / constraint
ALTER TABLE app.ai_usage ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE app.ai_usage ADD COLUMN IF NOT EXISTS unknown_outcome boolean NOT NULL DEFAULT false;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app.ai_usage'::regclass AND conname = 'ai_usage_user_chk') THEN
    ALTER TABLE app.ai_usage ADD CONSTRAINT ai_usage_user_chk CHECK (purpose = 'inbox' OR user_id IS NOT NULL);
  END IF;
END $chk$;
COMMENT ON TABLE app.ai_usage IS 'Append-only usage ledger of Claude use (purpose doc_extract: one request of a staff member | inbox: one inbox AI job, no user): inserted by public.ai_reserve (status reserved, held estimate), settled once by public.ai_settle (ok | refused | error, tokens and cost per attempt from app.ai_prices; an unknown outcome is stored as error with the held amount charged, unknown_outcome true). No DELETE; no UPDATE except that one settle (trigger trg_append_only). Counts and money only: no document or message content, no key.';
CREATE INDEX IF NOT EXISTS ai_usage_org_created_idx ON app.ai_usage (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_open_idx ON app.ai_usage (org_id, created_at) WHERE status = 'reserved';
ALTER TABLE app.ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_usage FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. helpers
-- ---------------------------------------------------------------------
-- the model the Edge Function asks for (also the engine name of an AI extraction)
CREATE OR REPLACE FUNCTION app.ai_model() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'claude-opus-5-5'::text
$$;

-- day / month boundaries in Saudi time (as app.msg_month_cost)
CREATE OR REPLACE FUNCTION app.ai_day_start() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'
$$;
CREATE OR REPLACE FUNCTION app.ai_month_start() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'
$$;

-- settings with defaults (no row = off, 50 / day, 20 USD / month)
CREATE OR REPLACE FUNCTION app.ai_settings_of(p_org uuid) RETURNS app.ai_settings
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v app.ai_settings;
BEGIN
  SELECT * INTO v FROM app.ai_settings s WHERE s.org_id = p_org;
  IF v.org_id IS NULL THEN
    v.org_id := p_org; v.enabled := false; v.daily_request_cap := 50; v.monthly_budget_usd := 20;
  END IF;
  RETURN v;
END $$;

-- cost estimate in USD; an unknown model is priced at the highest row (conservative)
CREATE OR REPLACE FUNCTION app.ai_cost_usd(p_model text, p_in int, p_out int) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT round((coalesce(p_in, 0)::numeric * x.i + coalesce(p_out, 0)::numeric * x.o) / 1000000, 6)
    FROM (SELECT coalesce((SELECT p.input_usd_per_mtok FROM app.ai_prices p WHERE p.model = p_model),
                          (SELECT max(p.input_usd_per_mtok) FROM app.ai_prices p), 0) i,
                 coalesce((SELECT p.output_usd_per_mtok FROM app.ai_prices p WHERE p.model = p_model),
                          (SELECT max(p.output_usd_per_mtok) FROM app.ai_prices p), 0) o) x
$$;

-- usage summary of an org (counts and money only)
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
                                                 GROUP BY x.purpose) z), '{}'::jsonb))
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
    'usage', app.ai_usage_json(p_org))
    FROM app.ai_settings_of(p_org) s
$$;

-- an AI extraction row may reference only an 'ok' doc_extract reading of the same org made by the caller
-- (SECURITY DEFINER: the trigger runs as the caller, who cannot read app.ai_usage)
CREATE OR REPLACE FUNCTION app.ai_usage_claimable(p_usage uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_usage IS NOT NULL AND auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.ai_usage u
     WHERE u.id = p_usage AND u.org_id = p_org AND u.user_id = auth.uid()
       AND u.purpose = 'doc_extract' AND u.status = 'ok')
$$;

-- append-only ledger: no DELETE; one UPDATE per row, from 'reserved' to a final status (the settle)
CREATE OR REPLACE FUNCTION app.tg_ai_usage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM app.fail('MRS_APPEND_ONLY', 'ai_usage'); END IF;
  IF OLD.status <> 'reserved' OR NEW.status NOT IN ('ok','refused','error') THEN
    PERFORM app.fail('MRS_APPEND_ONLY', 'ai_usage');
  END IF;
  PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','user_id','purpose','reserved_usd','created_at']);
  NEW.settled_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_append_only ON app.ai_usage;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON app.ai_usage
  FOR EACH ROW EXECUTE FUNCTION app.tg_ai_usage_guard();

-- ---------------------------------------------------------------------
-- 2. document_extractions: link an AI reading to its usage row
-- ---------------------------------------------------------------------
ALTER TABLE public.document_extractions
  ADD COLUMN IF NOT EXISTS ai_usage_id uuid CONSTRAINT document_extractions_ai_usage_fk REFERENCES app.ai_usage(id);
COMMENT ON COLUMN public.document_extractions.ai_usage_id IS 'AI reading (engine claude-opus-5-5): the app.ai_usage row of the Claude request that produced extracted_fields. Set once on insert, immutable; one extraction per reading.';
-- one reading = one extraction (also across voided rows: a voided AI reading is not re-saved from the same request)
CREATE UNIQUE INDEX IF NOT EXISTS document_extractions_ai_usage_uidx
  ON public.document_extractions (ai_usage_id) WHERE ai_usage_id IS NOT NULL;

-- extraction_field_keys (20261101000100 §1). AI: + the bill-of-lading parties / voyage keys Claude returns.
-- A superset: every stored row stays valid (CHECK document_extractions_fields_chk / _reviewed_chk).
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban',
               'vessel','voyage','port_of_loading','port_of_discharge','shipper','consignee']             -- AI
$$;

-- tg_document_extractions_before (20261101000100 §3). AI: an API insert of an AI reading (engine claude-opus-5-5 or
-- an ai_usage_id) needs both, and an 'ok' doc_extract usage row of the same org made by the caller;
-- ai_usage_id joins the immutable list.
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
      IF NEW.ai_usage_id IS NOT NULL OR NEW.engine = app.ai_model() THEN                                   -- AI
        IF NEW.ai_usage_id IS NULL OR NEW.engine IS DISTINCT FROM app.ai_model()                          -- AI
           OR NOT app.ai_usage_claimable(NEW.ai_usage_id, NEW.org_id) THEN                                -- AI
          PERFORM app.fail('MRS_INVALID', 'ai_usage_id');                                                 -- AI
        END IF;                                                                                           -- AI
      END IF;                                                                                             -- AI
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
        'reviewed_by','reviewed_at','voided_by','created_by','created_at','ai_usage_id']);                -- AI
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
-- 3. RPCs
-- ---------------------------------------------------------------------
-- ai_access(p_org) — staff of the org (MFA rule of app.has_role: an admin-only member needs aal2). Used by ocr.html
-- (show the AI mode) and by the Edge Function with the caller's own access token (the membership / aal check).
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
    'daily_remaining', greatest(s.daily_request_cap - v_today, 0));
END $$;

-- ai_get_settings(p_org) — org admin (aal2)
CREATE OR REPLACE FUNCTION public.ai_get_settings(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN app.ai_settings_json(p_org);
END $$;

-- ai_save_settings(p_org, {enabled, consent_ack, daily_request_cap, monthly_budget_usd}) — org admin (aal2).
-- Switching on (off → on) needs consent_ack = true in the same call: consent_ack_at / _by / consent_version are then
-- stamped (ai-doc-inbox-v2: document contents AND, when the inbox uses Claude, message text are sent to Anthropic). Audit row in public.audit_log (table_name 'ai_settings'; settings only, no content).
CREATE OR REPLACE FUNCTION public.ai_save_settings(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v app.ai_settings; v_old jsonb; v_new jsonb; v_b boolean; v_i int; v_n numeric; v_changed text[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['enabled','consent_ack','daily_request_cap','monthly_budget_usd']);
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
  IF p_payload ? 'enabled' THEN
    v_b := app.msg_rbool(p_payload, 'enabled');
    IF v_b IS NULL THEN PERFORM app.fail('MRS_INVALID', 'enabled'); END IF;
    IF v_b AND NOT v.enabled THEN
      -- off → on: the explicit consent (document contents and inbox message text are sent to Anthropic) is required now
      IF app.msg_rbool(p_payload, 'consent_ack') IS DISTINCT FROM true THEN PERFORM app.fail('MRS_REQUIRED', 'ai_consent'); END IF;
      v.consent_ack_at := now(); v.consent_ack_by := auth.uid(); v.consent_version := 'ai-doc-inbox-v2';
    END IF;
    v.enabled := v_b;
  END IF;

  UPDATE app.ai_settings s SET enabled = v.enabled, consent_ack_at = v.consent_ack_at, consent_ack_by = v.consent_ack_by,
         consent_version = v.consent_version, daily_request_cap = v.daily_request_cap,
         monthly_budget_usd = v.monthly_budget_usd, updated_by = auth.uid(), updated_at = now()
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

-- ai_reserve(p_org, p_user, p_purpose, p_est_usd) — service_role only. doc_extract: the ai-extract Edge Function,
-- after it verified the user's access token and called ai_access with it; re-checks an active staff membership of
-- p_user (by uid: a service call carries no user session) and the daily cap. inbox: the inbox-sync worker, one
-- reservation per AI job, no user (p_user NULL; when given it must be staff too), consent version ai-doc-inbox-v2
-- (it covers message text). Then enabled + consent and the monthly budget (both purposes), and inserts the 'reserved'
-- usage row holding p_est_usd (default 0.50). Returns the reservation id.
-- Refusals: MRS_FORBIDDEN service_only / not_staff, MRS_AI_DISABLED ai / consent, MRS_AI_DAILY_CAP, MRS_AI_BUDGET.
CREATE OR REPLACE FUNCTION public.ai_reserve(p_org uuid, p_user uuid, p_purpose text, p_est_usd numeric DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s app.ai_settings; v_est numeric := coalesce(p_est_usd, 0.50); v_today int; v_spent numeric; v_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_org IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'org'); END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('doc_extract','inbox') THEN PERFORM app.fail('MRS_INVALID', 'purpose'); END IF;
  IF p_user IS NULL AND p_purpose <> 'inbox' THEN PERFORM app.fail('MRS_REQUIRED', 'user'); END IF;
  IF v_est <= 0 OR v_est > 50 THEN PERFORM app.fail('MRS_INVALID', 'est_usd'); END IF;
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships m
                   JOIN public.organizations o ON o.id = m.org_id AND o.is_active
                  WHERE m.user_id = p_user AND m.org_id = p_org AND m.is_active AND m.role = ANY (app.staff_roles())
                    AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active))) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'not_staff');
  END IF;
  SELECT * INTO s FROM app.ai_settings x WHERE x.org_id = p_org FOR UPDATE;      -- serializes the org's reservations
  IF s.org_id IS NULL OR NOT s.enabled OR s.consent_ack_at IS NULL THEN PERFORM app.fail('MRS_AI_DISABLED', 'ai'); END IF;
  -- inbox use needs a consent that names message text (re-enable to give it)
  IF p_purpose = 'inbox' AND s.consent_version IS DISTINCT FROM 'ai-doc-inbox-v2' THEN PERFORM app.fail('MRS_AI_DISABLED', 'consent'); END IF;

  -- a reservation the Edge Function never settled (crash / timeout): settled 'error' at its held estimate
  UPDATE app.ai_usage u SET status = 'error', cost_usd = u.reserved_usd, stale = true
   WHERE u.org_id = p_org AND u.status = 'reserved' AND u.created_at < now() - interval '15 minutes';

  IF p_purpose = 'doc_extract' THEN
    SELECT count(*)::int INTO v_today FROM app.ai_usage u
     WHERE u.org_id = p_org AND u.purpose = 'doc_extract' AND u.created_at >= app.ai_day_start();
    IF v_today >= s.daily_request_cap THEN PERFORM app.fail('MRS_AI_DAILY_CAP', 'ai'); END IF;
  END IF;
  SELECT coalesce(sum(CASE WHEN u.status = 'reserved' THEN u.reserved_usd ELSE u.cost_usd END), 0) INTO v_spent
    FROM app.ai_usage u WHERE u.org_id = p_org AND u.created_at >= app.ai_month_start();
  IF v_spent + v_est > s.monthly_budget_usd THEN PERFORM app.fail('MRS_AI_BUDGET', 'ai'); END IF;

  INSERT INTO app.ai_usage (org_id, user_id, purpose, model, reserved_usd)
  VALUES (p_org, p_user, p_purpose, app.ai_model(), v_est)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- the 5-argument settle of an earlier copy of this file (replaced by the 6-argument one below)
DROP FUNCTION IF EXISTS public.ai_settle(uuid, int, int, text, text);
-- ai_settle(p_reservation, p_input_tokens, p_output_tokens, p_status, p_model, p_attempts) — service_role only. Once
-- per reservation.
--   p_status   ok | refused | error: the outcome is known; cost = the reported tokens at app.ai_prices.
--              unknown: the call failed after it may have run (timeout, connection lost, 5xx / 529) — stored as 'error'
--              with unknown_outcome, cost = the larger of the reported tokens' cost and the held amount.
--   p_attempts [{model, input_tokens, output_tokens}, …] (≤ 10): usage.iterations of a server-side fallback (a declined
--              attempt + the fallback model's), or the calls of one inbox job — each priced at its own model; the stored
--              tokens are their sums. NULL = one attempt: p_input_tokens / p_output_tokens at p_model.
--   p_model    the model that served the answer (a fallback may differ; NULL = the reserved model).
-- Tokens are usage.input_tokens + cache tokens and usage.output_tokens as the API reported them.
CREATE OR REPLACE FUNCTION public.ai_settle(p_reservation uuid, p_input_tokens int, p_output_tokens int, p_status text,
                                            p_model text DEFAULT NULL, p_attempts jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u app.ai_usage; v_model text; v_cost numeric := 0; v_in bigint := 0; v_out bigint := 0; v_status text;
        a jsonb; v_am text; v_ai bigint; v_ao bigint;
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
    END LOOP;
    IF v_in > 50000000 OR v_out > 50000000 THEN PERFORM app.fail('MRS_INVALID', 'attempts'); END IF;
  END IF;

  v_status := CASE WHEN p_status = 'unknown' THEN 'error' ELSE p_status END;
  IF p_status = 'unknown' THEN v_cost := greatest(v_cost, u.reserved_usd); END IF;
  UPDATE app.ai_usage x SET status = v_status, model = v_model, input_tokens = v_in::int, output_tokens = v_out::int,
         cost_usd = v_cost, unknown_outcome = (p_status = 'unknown')
   WHERE x.id = p_reservation;
  RETURN jsonb_build_object('id', u.id, 'status', v_status, 'unknown_outcome', p_status = 'unknown', 'model', v_model,
    'input_tokens', v_in, 'output_tokens', v_out, 'cost_usd', v_cost);
END $$;

-- ---------------------------------------------------------------------
-- 4. privileges
-- ---------------------------------------------------------------------
-- app helpers: called by SECURITY DEFINER code (owner) / the SQL Editor only
REVOKE EXECUTE ON FUNCTION app.ai_day_start(), app.ai_month_start(), app.ai_settings_of(uuid),
  app.ai_cost_usd(text, int, int), app.ai_usage_json(uuid), app.ai_settings_json(uuid), app.tg_ai_usage_guard()
FROM PUBLIC, anon, authenticated, service_role;
-- called from the (SECURITY INVOKER) extraction trigger, i.e. as the inserting staff member: authenticated only
REVOKE EXECUTE ON FUNCTION app.ai_model(), app.ai_usage_claimable(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.ai_model(), app.ai_usage_claimable(uuid, uuid) TO authenticated;
-- re-created bodies (as in 20261101000100 §4: the validator stays executable for the CHECK constraints)
REVOKE EXECUTE ON FUNCTION app.extraction_field_keys(), app.tg_document_extractions_before() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_field_keys() TO authenticated;

-- staff / org admin RPCs
REVOKE ALL ON FUNCTION public.ai_access(uuid), public.ai_get_settings(uuid), public.ai_save_settings(uuid, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_access(uuid), public.ai_get_settings(uuid), public.ai_save_settings(uuid, jsonb)
TO authenticated;
-- Edge Function RPCs: service_role only
REVOKE ALL ON FUNCTION public.ai_reserve(uuid, uuid, text, numeric), public.ai_settle(uuid, int, int, text, text, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_reserve(uuid, uuid, text, numeric), public.ai_settle(uuid, int, int, text, text, jsonb)
TO service_role;
