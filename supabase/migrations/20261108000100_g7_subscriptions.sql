-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261108000100 — G7 step ١١: subscription plans, per-org limits,
-- suspend / activate (docs/online/G7_SPEC.md § Data model). Builds on G6b.
--
-- NO billing, NO payment provider, NO Daftra call, NO network. Plans carry an optional price placeholder only
-- (G7-12). Limits are enforced SERVER-SIDE ONLY by additive BEFORE / AFTER triggers on the main create paths
-- (errors MRS_PLAN_LIMIT <metric> and MRS_PLAN_INACTIVE trial_expired | suspended | cancelled).
-- INERT BY DEFAULT: every existing and new org gets plan 'pilot' (all limits NULL = unlimited), status 'active'.
--   P. preflight (G6b applied) + schema_versions row
--   0. helpers     app.g7_metric_keys, app.g7_period, app.g7_overrides_valid, app.g7_limits, app.g7_used,
--                  app.g7_usage, app.g7_assert_active, app.g7_bump, app.g7_check, app.g7_recount (+ json helpers)
--   1. tables      plans, org_subscriptions, subscription_events (append-only), org_usage_counters (derived cache)
--   2. seeds (G7-13, ON CONFLICT DO NOTHING: a re-run never overwrites owner edits) + idempotent backfill
--   3. triggers    trg_g7_* on organizations, transactions, branches, memberships, invitations, documents,
--                  finance_documents, msg_attachments, msg_messages, msg_outbound, msg_ai_runs, msg_jobs
--   4. RPCs        platform_list_plans, platform_save_plan, platform_list_subscriptions, platform_set_org_plan,
--                  platform_suspend_org, platform_activate_org, platform_org_usage, platform_recount_usage,
--                  org_subscription
--   5. RLS (no policy, no API grant), audit, append-only, privileges
-- Adds no column to an existing table; replaces no pre-G7 function, trigger or policy. The trigger functions never
-- change the inserted row and write only org_usage_counters (and, for a new org, its subscription row + event).
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS / ON CONFLICT DO NOTHING).
-- Down-path (data untouched): drop the trg_g7_* triggers to disable enforcement; the tables may stay.
-- =====================================================================

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261107000100') THEN
    RAISE EXCEPTION 'G7 preflight: apply G6b first (schema_versions lacks 20261107000100 g6b_inbox)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261108000100', 'g7_subscriptions')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0a. pure helpers (needed by the table CHECKs)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.g7_metric_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['users','branches','transactions_month','storage_mb','messages_month','ai_runs_month']
$$;

-- G7-8: calendar month in Asia/Riyadh
CREATE OR REPLACE FUNCTION app.g7_period(ts timestamptz DEFAULT now()) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT date_trunc('month', (coalesce(ts, now()) AT TIME ZONE 'Asia/Riyadh'))::date
$$;

-- limit_overrides: an object, keys ⊆ the six metric keys, values non-negative integers ≤ 10^9 (never raises)
CREATE OR REPLACE FUNCTION app.g7_overrides_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  FOR k, v IN SELECT e.key, e.value FROM jsonb_each(p) e LOOP
    IF NOT (k = ANY (app.g7_metric_keys())) THEN RETURN false; END IF;
    IF jsonb_typeof(v) <> 'number' THEN RETURN false; END IF;
    IF (v #>> '{}')::numeric < 0 OR (v #>> '{}')::numeric > 1000000000
       OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------
-- 1. tables (no-API: RLS on, no policy, no grant — read through the RPCs only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plans (
  code               text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name_ar            text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 80),
  name_en            text CHECK (char_length(name_en) <= 80),
  sort               int NOT NULL DEFAULT 100,
  is_active          boolean NOT NULL DEFAULT true,
  max_users          int CHECK (max_users >= 0),
  max_branches       int CHECK (max_branches >= 0),
  max_tx_month       int CHECK (max_tx_month >= 0),
  max_storage_mb     bigint CHECK (max_storage_mb >= 0),
  max_messages_month int CHECK (max_messages_month >= 0),
  max_ai_runs_month  int CHECK (max_ai_runs_month >= 0),
  price_monthly_sar  numeric(12,2) CHECK (price_monthly_sar >= 0),
  notes              text CHECK (char_length(notes) <= 2000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
);
COMMENT ON TABLE public.plans IS 'G7 subscription plans (platform catalogue). Limits NULL = unlimited. price_monthly_sar is a placeholder (owner decision, G7-12). Seed values are «قيم مبدئية — قرار المالك».';

CREATE TABLE IF NOT EXISTS public.org_subscriptions (
  org_id          uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_code       text NOT NULL REFERENCES public.plans(code),
  status          text NOT NULL CHECK (status IN ('trial','active','suspended','cancelled')),
  period_start    date NOT NULL,
  period_end      date CHECK (period_end IS NULL OR period_end >= period_start),
  limit_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (app.g7_overrides_valid(limit_overrides)),
  status_reason   text CHECK (char_length(status_reason) <= 2000),
  suspended_at    timestamptz,
  suspended_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  CONSTRAINT org_subscriptions_trial_end CHECK (status <> 'trial' OR period_end IS NOT NULL)
);
COMMENT ON TABLE public.org_subscriptions IS 'G7 one subscription per org (plan, status, period, per-org limit overrides). Platform admins only (RPCs).';
CREATE INDEX IF NOT EXISTS org_subscriptions_plan_idx ON public.org_subscriptions (plan_code);

CREATE TABLE IF NOT EXISTS public.subscription_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor       uuid,
  action      text NOT NULL CHECK (action IN ('created','plan_changed','limits_changed','period_changed','status_changed',
                                              'suspended','activated','cancelled','recounted')),
  from_plan   text,
  to_plan     text,
  from_status text,
  to_status   text,
  reason      text CHECK (char_length(reason) <= 2000),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
COMMENT ON TABLE public.subscription_events IS 'G7 append-only history of subscription changes (counts / limits only, never tenant data). actor NULL = migration / system.';
CREATE INDEX IF NOT EXISTS subscription_events_org_idx ON public.subscription_events (org_id, at DESC);

CREATE TABLE IF NOT EXISTS public.org_usage_counters (
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  metric       text NOT NULL CHECK (metric IN ('transactions_month','messages_month','ai_runs_month','storage_bytes')),
  period_start date NOT NULL,
  value        bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, metric, period_start)
);
COMMENT ON TABLE public.org_usage_counters IS 'G7 derived usage cache (monthly counters keyed by Asia/Riyadh month; storage_bytes cumulative at 1970-01-01). Reconciled by app.g7_recount.';

-- ---------------------------------------------------------------------
-- 0b. helpers reading the new tables (SECURITY DEFINER, no grant)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.g7_plan_limits(p public.plans) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('users', p.max_users, 'branches', p.max_branches, 'transactions_month', p.max_tx_month,
                            'storage_mb', p.max_storage_mb, 'messages_month', p.max_messages_month, 'ai_runs_month', p.max_ai_runs_month)
$$;

-- effective limits = override if present, else the plan column (JSON null = unlimited); no subscription row ⇒ pilot
CREATE OR REPLACE FUNCTION app.g7_limits(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions; p public.plans; v_base jsonb; v_res jsonb := '{}'::jsonb; k text;
BEGIN
  SELECT * INTO s FROM public.org_subscriptions x WHERE x.org_id = p_org;
  SELECT * INTO p FROM public.plans x WHERE x.code = coalesce(s.plan_code, 'pilot');
  IF p.code IS NULL THEN
    v_base := jsonb_build_object('users', NULL, 'branches', NULL, 'transactions_month', NULL, 'storage_mb', NULL,
                                 'messages_month', NULL, 'ai_runs_month', NULL);
  ELSE
    v_base := app.g7_plan_limits(p);
  END IF;
  FOREACH k IN ARRAY app.g7_metric_keys() LOOP
    v_res := v_res || jsonb_build_object(k, CASE WHEN coalesce(s.limit_overrides, '{}'::jsonb) ? k THEN s.limit_overrides -> k ELSE v_base -> k END);
  END LOOP;
  RETURN v_res;
END $$;

CREATE OR REPLACE FUNCTION app.g7_counter(p_org uuid, p_metric text, p_period date) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT c.value FROM public.org_usage_counters c
                    WHERE c.org_id = p_org AND c.metric = p_metric AND c.period_start = p_period), 0)
$$;

-- current usage of one metric key (users / branches live; storage_mb = ceil(bytes / 1 MiB); monthly = current period)
CREATE OR REPLACE FUNCTION app.g7_used(p_org uuid, p_metric text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  CASE p_metric
    WHEN 'users' THEN
      RETURN (SELECT count(DISTINCT m.user_id) FROM public.memberships m
                LEFT JOIN public.branches b ON b.id = m.branch_id
               WHERE m.org_id = p_org AND m.is_active AND m.role <> 'client' AND (m.branch_id IS NULL OR b.is_active));
    WHEN 'branches' THEN
      RETURN (SELECT count(*) FROM public.branches b WHERE b.org_id = p_org AND b.is_active);
    WHEN 'storage_mb' THEN
      RETURN ceil(app.g7_counter(p_org, 'storage_bytes', DATE '1970-01-01') / 1048576.0)::bigint;
    WHEN 'storage_bytes' THEN
      RETURN app.g7_counter(p_org, 'storage_bytes', DATE '1970-01-01');
    WHEN 'transactions_month', 'messages_month', 'ai_runs_month' THEN
      RETURN app.g7_counter(p_org, p_metric, app.g7_period(now()));
    ELSE
      PERFORM app.fail('MRS_INVALID', 'metric');
  END CASE;
  RETURN NULL;
END $$;

-- {users, branches, transactions_month, storage_mb, messages_month, ai_runs_month, over_limit: [keys]} for the current period
CREATE OR REPLACE FUNCTION app.g7_usage(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_lim jsonb := app.g7_limits(p_org); v_res jsonb := '{}'::jsonb; v_over text[] := '{}'; k text; v_used bigint;
BEGIN
  FOREACH k IN ARRAY app.g7_metric_keys() LOOP
    v_used := app.g7_used(p_org, k);
    v_res := v_res || jsonb_build_object(k, v_used);
    IF jsonb_typeof(v_lim -> k) = 'number' AND v_used > (v_lim ->> k)::bigint THEN v_over := v_over || k; END IF;
  END LOOP;
  RETURN v_res || jsonb_build_object('over_limit', to_jsonb(v_over));
END $$;

-- MRS_PLAN_INACTIVE trial_expired | suspended | cancelled; no row / active / unexpired trial pass
CREATE OR REPLACE FUNCTION app.g7_assert_active(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions;
BEGIN
  SELECT * INTO s FROM public.org_subscriptions x WHERE x.org_id = p_org;
  IF s.org_id IS NULL OR s.status = 'active' THEN RETURN; END IF;
  IF s.status = 'trial' THEN
    IF (now() AT TIME ZONE 'Asia/Riyadh')::date > s.period_end THEN PERFORM app.fail('MRS_PLAN_INACTIVE', 'trial_expired'); END IF;
    RETURN;
  END IF;
  PERFORM app.fail('MRS_PLAN_INACTIVE', s.status);
END $$;

-- counter bump (+ enforcement): the row lock of the upsert serializes concurrent creates of one org / metric / month;
-- the raise rolls the bump back with the statement. storage_bytes is compared with storage_mb × 1 MiB.
CREATE OR REPLACE FUNCTION app.g7_bump(p_org uuid, p_metric text, p_n bigint, p_enforce boolean, p_at timestamptz DEFAULT now()) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_period date; v_val bigint; v_key text; v_lim jsonb; v_limit numeric;
BEGIN
  IF p_org IS NULL OR coalesce(p_n, 0) <= 0 THEN RETURN NULL; END IF;
  -- review fix (recount race): bumps share a per-org advisory lock that app.g7_recount takes exclusively, so a recount
  -- never computes its sums while a bump of the same org is still uncommitted (it would overwrite N+1 with N)
  PERFORM pg_advisory_xact_lock_shared(hashtext('marsa.g7.usage'), hashtext(p_org::text));
  v_period := CASE WHEN p_metric = 'storage_bytes' THEN DATE '1970-01-01' ELSE app.g7_period(coalesce(p_at, now())) END;
  INSERT INTO public.org_usage_counters AS c (org_id, metric, period_start, value)
  VALUES (p_org, p_metric, v_period, p_n)
  ON CONFLICT (org_id, metric, period_start) DO UPDATE SET value = c.value + EXCLUDED.value, updated_at = now()
  RETURNING c.value INTO v_val;
  IF p_enforce THEN
    v_key := CASE WHEN p_metric = 'storage_bytes' THEN 'storage_mb' ELSE p_metric END;
    v_lim := app.g7_limits(p_org) -> v_key;
    IF jsonb_typeof(v_lim) = 'number' THEN
      v_limit := (v_lim #>> '{}')::numeric * CASE WHEN p_metric = 'storage_bytes' THEN 1048576 ELSE 1 END;
      IF v_val > v_limit THEN PERFORM app.fail('MRS_PLAN_LIMIT', v_key); END IF;
    END IF;
  END IF;
  RETURN v_val;
END $$;

-- real byte size of a stored object (storage.objects metadata.size), NULL when the object or its size is missing.
-- plpgsql on purpose: the storage schema is resolved at call time (callers fall back when it is not readable).
CREATE OR REPLACE FUNCTION app.g7_object_size(p_bucket text, p_name text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text;
BEGIN
  SELECT o.metadata ->> 'size' INTO v FROM storage.objects o WHERE o.bucket_id = p_bucket AND o.name = p_name;
  IF v IS NULL OR v !~ '^[0-9]{1,15}$' THEN RETURN NULL; END IF;
  RETURN v::bigint;
END $$;

-- "at limit" check without a bump (users, branches, outbound messages, draft requests): used >= limit → MRS_PLAN_LIMIT.
-- Locks the subscription row only when a limit applies (serializes concurrent adds; inert for unlimited plans).
-- review fix (queued work): work already accepted but not yet counted — outbound sends still in flight (their msg_messages
-- copy is written only after the provider accepts) and staff draft jobs not yet finished (their msg_ai_runs row is written
-- when the job completes). Counted by the "at limit" checks so queued work cannot overshoot a monthly limit.
CREATE OR REPLACE FUNCTION app.g7_pending(p_org uuid, p_metric text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE p_metric
    WHEN 'messages_month' THEN (SELECT count(*) FROM public.msg_outbound o
                                 WHERE o.org_id = p_org AND o.state IN ('queued','sending','unknown')
                                   AND NOT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.outbound_id = o.id))
    WHEN 'ai_runs_month' THEN (SELECT count(*) FROM public.msg_jobs j
                                WHERE j.org_id = p_org AND j.kind = 'draft' AND j.status IN ('queued','running','unknown'))
    ELSE 0::bigint END
$$;

CREATE OR REPLACE FUNCTION app.g7_check(p_org uuid, p_metric text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_lim jsonb;
BEGIN
  IF p_org IS NULL THEN RETURN; END IF;
  v_lim := app.g7_limits(p_org) -> p_metric;
  IF jsonb_typeof(v_lim) <> 'number' THEN RETURN; END IF;
  PERFORM 1 FROM public.org_subscriptions s WHERE s.org_id = p_org FOR UPDATE;
  IF app.g7_used(p_org, p_metric) + app.g7_pending(p_org, p_metric) >= (v_lim #>> '{}')::bigint THEN
    PERFORM app.fail('MRS_PLAN_LIMIT', p_metric);
  END IF;
END $$;

-- SETS (never adds) the monthly counters of every month that has rows (+ the current month) and storage_bytes
-- from the real rows. Idempotent. Returns the current usage.
-- The exclusive per-org advisory lock (shared by app.g7_bump) is taken in its own statement first: the INSERT … SELECT
-- below then reads a snapshot taken after every in-flight bump of this org has committed (review fix: recount race).
-- Storage uses the real object size (storage.objects metadata) when the object exists, else the declared size_bytes.
CREATE OR REPLACE FUNCTION app.g7_recount(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_cur date := app.g7_period(now()); v_storage bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('marsa.g7.usage'), hashtext(p_org::text));
  BEGIN
    SELECT coalesce((SELECT sum(coalesce(app.g7_object_size('documents', d.storage_path), d.size_bytes)) FROM public.documents d WHERE d.org_id = p_org), 0)
         + coalesce((SELECT sum(coalesce(app.g7_object_size('finance', f.storage_path), f.size_bytes)) FROM public.finance_documents f WHERE f.org_id = p_org), 0)
         + coalesce((SELECT sum(a.size_bytes) FROM public.msg_attachments a WHERE a.org_id = p_org), 0)
      INTO v_storage;
  EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
    -- storage schema not readable here: fall back to the declared sizes
    SELECT coalesce((SELECT sum(d.size_bytes) FROM public.documents d WHERE d.org_id = p_org), 0)
         + coalesce((SELECT sum(f.size_bytes) FROM public.finance_documents f WHERE f.org_id = p_org), 0)
         + coalesce((SELECT sum(a.size_bytes) FROM public.msg_attachments a WHERE a.org_id = p_org), 0)
      INTO v_storage;
  END;
  INSERT INTO public.org_usage_counters AS c (org_id, metric, period_start, value)
  SELECT p_org, x.metric, x.p, sum(x.n)::bigint FROM (
      SELECT 'transactions_month'::text metric, app.g7_period(t.created_at) p, count(*) n FROM public.transactions t WHERE t.org_id = p_org GROUP BY 2
      UNION ALL SELECT 'messages_month', app.g7_period(m.created_at), count(*) FROM public.msg_messages m WHERE m.org_id = p_org GROUP BY 2
      UNION ALL SELECT 'ai_runs_month', app.g7_period(r.created_at), count(*) FROM public.msg_ai_runs r WHERE r.org_id = p_org GROUP BY 2
      UNION ALL SELECT k, v_cur, 0 FROM unnest(ARRAY['transactions_month','messages_month','ai_runs_month']) k
      UNION ALL SELECT 'storage_bytes', DATE '1970-01-01', v_storage
    ) x
  GROUP BY x.metric, x.p
  ON CONFLICT (org_id, metric, period_start) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE c.value IS DISTINCT FROM EXCLUDED.value;
  RETURN app.g7_usage(p_org);
END $$;

-- subscription row of an org, locked; created (pilot / active) when missing (never for an unknown org)
CREATE OR REPLACE FUNCTION app.g7_sub_lock(p_org uuid) RETURNS public.org_subscriptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions; v_created timestamptz;
BEGIN
  SELECT * INTO s FROM public.org_subscriptions x WHERE x.org_id = p_org FOR UPDATE;
  IF s.org_id IS NOT NULL THEN RETURN s; END IF;
  SELECT o.created_at INTO v_created FROM public.organizations o WHERE o.id = p_org;
  IF v_created IS NULL THEN RETURN s; END IF;
  INSERT INTO public.org_subscriptions (org_id, plan_code, status, period_start)
  VALUES (p_org, 'pilot', 'active', (v_created AT TIME ZONE 'Asia/Riyadh')::date)
  ON CONFLICT (org_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.subscription_events (org_id, actor, action, to_plan, to_status, detail)
    VALUES (p_org, auth.uid(), 'created', 'pilot', 'active', '{"source":"on_demand"}'::jsonb);
  END IF;
  SELECT * INTO s FROM public.org_subscriptions x WHERE x.org_id = p_org FOR UPDATE;
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION app.g7_plan_json(p public.plans) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('code', p.code, 'name_ar', p.name_ar, 'name_en', p.name_en, 'sort', p.sort, 'is_active', p.is_active,
           'limits', app.g7_plan_limits(p), 'price_monthly_sar', p.price_monthly_sar, 'notes', p.notes,
           'orgs', (SELECT count(*) FROM public.org_subscriptions s WHERE s.plan_code = p.code),
           'updated_at', p.updated_at)
$$;

CREATE OR REPLACE FUNCTION app.g7_sub_json(s public.org_subscriptions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('org_id', s.org_id, 'plan_code', s.plan_code,
           'plan_name_ar', (SELECT p.name_ar FROM public.plans p WHERE p.code = s.plan_code),
           'plan_name_en', (SELECT p.name_en FROM public.plans p WHERE p.code = s.plan_code),
           'status', s.status, 'period_start', s.period_start, 'period_end', s.period_end,
           'limit_overrides', s.limit_overrides, 'limits', app.g7_limits(s.org_id), 'status_reason', s.status_reason,
           'suspended_at', s.suspended_at, 'updated_at', s.updated_at)
$$;

-- ---------------------------------------------------------------------
-- 2. seeds (G7-13 placeholders «قيم مبدئية — قرار المالك»; never overwritten by a re-run) + backfill
-- ---------------------------------------------------------------------
INSERT INTO public.plans (code, name_ar, name_en, sort, max_users, max_branches, max_tx_month, max_storage_mb,
                          max_messages_month, max_ai_runs_month, price_monthly_sar, notes) VALUES
  ('pilot', 'تجريبية (بلا حدود)', 'Pilot (unlimited)', 10, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'الباقة الافتراضية لكل مؤسسة: بلا حدود. لا يمكن إيقافها.'),
  ('basic', 'أساسية', 'Basic', 20, 5, 1, 300, 10240, 3000, 500, NULL, 'قيم مبدئية — قرار المالك. لم تُسعَّر.'),
  ('pro', 'احترافية', 'Pro', 30, 25, 5, 3000, 102400, 30000, 5000, NULL, 'قيم مبدئية — قرار المالك. لم تُسعَّر.'),
  ('enterprise', 'مؤسسية (عقد خاص)', 'Enterprise (custom contract)', 40, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'قيم مبدئية — قرار المالك. الحدود حسب العقد.')
ON CONFLICT (code) DO NOTHING;

-- every org lacking a subscription → pilot / active (event 'created' only for the rows actually inserted)
WITH ins AS (
  INSERT INTO public.org_subscriptions (org_id, plan_code, status, period_start)
  SELECT o.id, 'pilot', 'active', (o.created_at AT TIME ZONE 'Asia/Riyadh')::date FROM public.organizations o
  ON CONFLICT (org_id) DO NOTHING
  RETURNING org_id
)
INSERT INTO public.subscription_events (org_id, actor, action, to_plan, to_status, detail)
SELECT ins.org_id, NULL, 'created', 'pilot', 'active', '{"source":"backfill"}'::jsonb FROM ins;

-- idempotent recount (sets, never adds)
DO $bf$
DECLARE r record;
BEGIN
  FOR r IN SELECT o.id FROM public.organizations o ORDER BY o.id LOOP
    PERFORM app.g7_recount(r.id);
  END LOOP;
END $bf$;

-- ---------------------------------------------------------------------
-- 3. triggers on existing tables (additive; never change NEW; write only the usage cache)
-- ---------------------------------------------------------------------
-- new org → pilot / active subscription + event (platform_create_org untouched)
CREATE OR REPLACE FUNCTION app.g7_tg_org_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.org_subscriptions (org_id, plan_code, status, period_start, updated_by)
  VALUES (NEW.id, 'pilot', 'active', (coalesce(NEW.created_at, now()) AT TIME ZONE 'Asia/Riyadh')::date, auth.uid())
  ON CONFLICT (org_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.subscription_events (org_id, actor, action, to_plan, to_status, detail)
    VALUES (NEW.id, auth.uid(), 'created', 'pilot', 'active', '{"source":"org_created"}'::jsonb);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g7_org_insert ON public.organizations;
CREATE TRIGGER trg_g7_org_insert AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION app.g7_tg_org_insert();

-- G7-14: re-enabling a suspended / cancelled subscription's org only through platform_activate_org
CREATE OR REPLACE FUNCTION app.g7_tg_org_reactivate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.is_active AND NOT OLD.is_active
     AND EXISTS (SELECT 1 FROM public.org_subscriptions s WHERE s.org_id = NEW.id AND s.status IN ('suspended','cancelled'))
     AND coalesce(current_setting('app.g7_activating', true), '') <> 'on' THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'subscription_suspended');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_org_reactivate ON public.organizations;
CREATE TRIGGER trg_g7_org_reactivate BEFORE UPDATE OF is_active ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION app.g7_tg_org_reactivate();

-- transactions (convert_request_to_transaction, direct staff / SQL insert): E active + transactions_month
CREATE OR REPLACE FUNCTION app.g7_tg_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_assert_active(NEW.org_id);
  PERFORM app.g7_bump(NEW.org_id, 'transactions_month', 1, true, coalesce(NEW.created_at, now()));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_transaction ON public.transactions;
CREATE TRIGGER trg_g7_transaction BEFORE INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.g7_tg_transaction();

-- review fix (back-dated insert bypass): an API caller (direct staff INSERT through RLS) cannot choose created_at — it is
-- forced to now(), the pattern of tg_events_before, so the counter month is always the real one. SECURITY INVOKER on
-- purpose: app.is_api_caller() must see the real caller role. Fires after trg_before and before trg_g7_transaction
-- (BEFORE triggers run in name order). The SQL Editor / service-role legacy import keeps its historical created_at.
-- This is the only G7 trigger that touches NEW, and only that one column.
CREATE OR REPLACE FUNCTION app.g7_tg_tx_created_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_created_at ON public.transactions;
CREATE TRIGGER trg_g7_created_at BEFORE INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.g7_tg_tx_created_at();

-- branches: create active / reactivate → E active + branches; a reactivation also re-checks users: members of that
-- branch who are counted nowhere else become counted again (review fix: deactivate → add users → reactivate bypass)
CREATE OR REPLACE FUNCTION app.g7_tg_branch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_lim jsonb; v_add bigint;
BEGIN
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
    PERFORM app.g7_assert_active(NEW.org_id);
    PERFORM app.g7_check(NEW.org_id, 'branches');
    IF TG_OP = 'UPDATE' THEN
      v_lim := app.g7_limits(NEW.org_id) -> 'users';
      IF jsonb_typeof(v_lim) = 'number' THEN
        PERFORM 1 FROM public.org_subscriptions s WHERE s.org_id = NEW.org_id FOR UPDATE;
        SELECT count(DISTINCT m.user_id) INTO v_add FROM public.memberships m
         WHERE m.org_id = NEW.org_id AND m.branch_id = NEW.id AND m.is_active AND m.role <> 'client'
           AND NOT EXISTS (SELECT 1 FROM public.memberships m2 LEFT JOIN public.branches b ON b.id = m2.branch_id
                            WHERE m2.org_id = NEW.org_id AND m2.user_id = m.user_id AND m2.is_active AND m2.role <> 'client'
                              AND (m2.branch_id IS NULL OR (b.is_active AND b.id <> NEW.id)));
        -- BEFORE UPDATE: g7_used still sees this branch inactive, so these users are not counted twice
        IF v_add > 0 AND app.g7_used(NEW.org_id, 'users') + v_add > (v_lim #>> '{}')::bigint THEN
          PERFORM app.fail('MRS_PLAN_LIMIT', 'users');
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_branch ON public.branches;
CREATE TRIGGER trg_g7_branch BEFORE INSERT OR UPDATE OF is_active ON public.branches FOR EACH ROW EXECUTE FUNCTION app.g7_tg_branch();

-- memberships (admin_add_member, accept_invitation, reactivation, role change): a row that becomes an active staff
-- membership (org-wide or active branch) of a user not yet counted → E active + users (G7-3)
CREATE OR REPLACE FUNCTION app.g7_tg_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_new boolean; v_old boolean := false;
BEGIN
  v_new := NEW.is_active AND NEW.role <> 'client'
           AND (NEW.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = NEW.branch_id AND b.is_active));
  IF NOT v_new THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    v_old := OLD.is_active AND OLD.role <> 'client' AND OLD.user_id = NEW.user_id AND OLD.org_id = NEW.org_id
             AND (OLD.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = OLD.branch_id AND b.is_active));
    IF v_old THEN RETURN NEW; END IF;
  END IF;
  -- a second role of an already counted user does not count again
  IF EXISTS (SELECT 1 FROM public.memberships m LEFT JOIN public.branches b ON b.id = m.branch_id
              WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id AND m.id <> NEW.id
                AND m.is_active AND m.role <> 'client' AND (m.branch_id IS NULL OR b.is_active)) THEN
    RETURN NEW;
  END IF;
  PERFORM app.g7_assert_active(NEW.org_id);
  PERFORM app.g7_check(NEW.org_id, 'users');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_membership ON public.memberships;
CREATE TRIGGER trg_g7_membership BEFORE INSERT OR UPDATE OF is_active, role, branch_id ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION app.g7_tg_membership();

-- invitations: a staff invitation is refused when active users ≥ limit (pending invitations themselves do not count)
CREATE OR REPLACE FUNCTION app.g7_tg_invitation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_assert_active(NEW.org_id);
  PERFORM app.g7_check(NEW.org_id, 'users');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_invitation ON public.invitations;
CREATE TRIGGER trg_g7_invitation BEFORE INSERT ON public.invitations
  FOR EACH ROW WHEN (NEW.role <> 'client') EXECUTE FUNCTION app.g7_tg_invitation();

-- documents / finance_documents: E active + storage (bytes; cumulative, voided rows keep their bytes)
CREATE OR REPLACE FUNCTION app.g7_tg_storage_enforced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_assert_active(NEW.org_id);
  PERFORM app.g7_bump(NEW.org_id, 'storage_bytes', NEW.size_bytes, true);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_storage ON public.documents;
CREATE TRIGGER trg_g7_storage BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION app.g7_tg_storage_enforced();
DROP TRIGGER IF EXISTS trg_g7_storage ON public.finance_documents;
CREATE TRIGGER trg_g7_storage BEFORE INSERT ON public.finance_documents FOR EACH ROW EXECUTE FUNCTION app.g7_tg_storage_enforced();

-- message attachments: counted, never refused (G7-6)
CREATE OR REPLACE FUNCTION app.g7_tg_attachment_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_bump(NEW.org_id, 'storage_bytes', NEW.size_bytes, false);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g7_storage ON public.msg_attachments;
CREATE TRIGGER trg_g7_storage AFTER INSERT ON public.msg_attachments FOR EACH ROW EXECUTE FUNCTION app.g7_tg_attachment_count();

-- messages (inbound + outbound copies): counted, never refused (G7-4)
CREATE OR REPLACE FUNCTION app.g7_tg_message_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_bump(NEW.org_id, 'messages_month', 1, false, coalesce(NEW.created_at, now()));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g7_count ON public.msg_messages;
CREATE TRIGGER trg_g7_count AFTER INSERT ON public.msg_messages FOR EACH ROW EXECUTE FUNCTION app.g7_tg_message_count();

-- outbound (send_msg_reply; retry_msg_send re-queues failed → queued): E active + messages_month at limit, counting the
-- sends still in flight (app.g7_pending)
CREATE OR REPLACE FUNCTION app.g7_tg_outbound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.state = 'failed' AND NEW.state = 'queued') THEN RETURN NEW; END IF;
  PERFORM app.g7_assert_active(NEW.org_id);
  PERFORM app.g7_check(NEW.org_id, 'messages_month');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_limit ON public.msg_outbound;
CREATE TRIGGER trg_g7_limit BEFORE INSERT OR UPDATE OF state ON public.msg_outbound FOR EACH ROW EXECUTE FUNCTION app.g7_tg_outbound();

-- AI runs (process + draft): counted, never refused (G7-5)
CREATE OR REPLACE FUNCTION app.g7_tg_ai_run_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_bump(NEW.org_id, 'ai_runs_month', 1, false, coalesce(NEW.created_at, now()));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g7_count ON public.msg_ai_runs;
CREATE TRIGGER trg_g7_count AFTER INSERT ON public.msg_ai_runs FOR EACH ROW EXECUTE FUNCTION app.g7_tg_ai_run_count();

-- staff draft requests (request_msg_draft): E active + ai_runs_month at limit; process jobs never refused
CREATE OR REPLACE FUNCTION app.g7_tg_draft_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.g7_assert_active(NEW.org_id);
  PERFORM app.g7_check(NEW.org_id, 'ai_runs_month');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g7_limit ON public.msg_jobs;
CREATE TRIGGER trg_g7_limit BEFORE INSERT ON public.msg_jobs FOR EACH ROW WHEN (NEW.kind = 'draft') EXECUTE FUNCTION app.g7_tg_draft_job();

-- review fix (declared size): the stored object must have the size its documents / finance_documents row declared
-- (the row is what app.g7_tg_storage_enforced counted). AFTER INSERT OR UPDATE OF metadata on storage.objects: the size
-- may arrive with the insert or with a later metadata update. Objects without a size, of other buckets, or without a
-- registered row are left to the existing bucket policies.
CREATE OR REPLACE FUNCTION app.g7_tg_object_size() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_txt text; v_decl bigint;
BEGIN
  IF NEW.bucket_id IS NULL OR NEW.bucket_id NOT IN ('documents','finance') THEN RETURN NULL; END IF;
  v_txt := NEW.metadata ->> 'size';
  IF v_txt IS NULL OR v_txt !~ '^[0-9]{1,15}$' THEN RETURN NULL; END IF;
  IF NEW.bucket_id = 'documents' THEN
    SELECT d.size_bytes INTO v_decl FROM public.documents d WHERE d.storage_bucket = 'documents' AND d.storage_path = NEW.name;
  ELSE
    SELECT f.size_bytes INTO v_decl FROM public.finance_documents f WHERE f.storage_bucket = 'finance' AND f.storage_path = NEW.name;
  END IF;
  IF v_decl IS NOT NULL AND v_decl <> v_txt::bigint THEN PERFORM app.fail('MRS_INVALID', 'size_bytes'); END IF;
  RETURN NULL;
END $$;
DO $obj$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE WARNING 'G7: storage.objects missing — trg_g7_object_size not installed (declared sizes not verified)';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS trg_g7_object_size ON storage.objects;
  CREATE TRIGGER trg_g7_object_size AFTER INSERT OR UPDATE OF metadata ON storage.objects
    FOR EACH ROW EXECUTE FUNCTION app.g7_tg_object_size();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'G7: no TRIGGER privilege on storage.objects — trg_g7_object_size not installed (declared sizes not verified; recount still uses object sizes)';
END $obj$;

-- append-only guard for subscription_events
CREATE OR REPLACE FUNCTION app.g7_tg_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------
-- 4. platform / org RPCs
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_list_plans() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((SELECT jsonb_agg(app.g7_plan_json(p) ORDER BY p.sort, p.code) FROM public.plans p), '[]'::jsonb);
END $$;

-- create or update {name_ar, name_en?, sort?, is_active?, limits:{…}, price_monthly_sar?, notes?}; code immutable
CREATE OR REPLACE FUNCTION public.platform_save_plan(p_code text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.plans; v_new boolean; v_lim jsonb; k text; v jsonb; v_n numeric; v_txt text; v_cols text[] :=
  ARRAY['max_users','max_branches','max_tx_month','max_storage_mb','max_messages_month','max_ai_runs_month'];
  v_vals bigint[]; i int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{1,30}$' THEN PERFORM app.fail('MRS_INVALID', 'code'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['name_ar','name_en','sort','is_active','limits','price_monthly_sar','notes']);
  SELECT * INTO p FROM public.plans x WHERE x.code = p_code FOR UPDATE;
  v_new := p.code IS NULL;
  IF v_new THEN
    p.code := p_code; p.sort := 100; p.is_active := true;
  END IF;
  IF v_new OR p_payload ? 'name_ar' THEN
    v_txt := app.ptext(p_payload, 'name_ar', 80, true);
    IF char_length(v_txt) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
    p.name_ar := v_txt;
  END IF;
  IF p_payload ? 'name_en' THEN p.name_en := app.ptext(p_payload, 'name_en', 80); END IF;
  IF p_payload ? 'sort' THEN
    IF jsonb_typeof(p_payload -> 'sort') <> 'number' OR (p_payload ->> 'sort')::numeric <> trunc((p_payload ->> 'sort')::numeric)
       OR abs((p_payload ->> 'sort')::numeric) > 100000 THEN
      PERFORM app.fail('MRS_INVALID', 'sort');
    END IF;
    p.sort := (p_payload ->> 'sort')::int;
  END IF;
  IF p_payload ? 'is_active' THEN
    IF jsonb_typeof(p_payload -> 'is_active') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'is_active'); END IF;
    p.is_active := (p_payload ->> 'is_active')::boolean;
  END IF;
  IF p.code = 'pilot' AND NOT p.is_active THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'pilot_required'); END IF;
  IF p_payload ? 'limits' THEN
    v_lim := p_payload -> 'limits';
    IF jsonb_typeof(v_lim) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'limits'); END IF;
    v_vals := ARRAY[p.max_users, p.max_branches, p.max_tx_month, p.max_storage_mb, p.max_messages_month, p.max_ai_runs_month];
    FOR k, v IN SELECT e.key, e.value FROM jsonb_each(v_lim) e LOOP
      i := array_position(app.g7_metric_keys(), k);
      IF i IS NULL THEN PERFORM app.fail('MRS_INVALID', 'limits'); END IF;
      IF jsonb_typeof(v) = 'null' THEN
        v_vals[i] := NULL;
      ELSE
        IF jsonb_typeof(v) <> 'number' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
        v_n := (v #>> '{}')::numeric;
        IF v_n < 0 OR v_n > 1000000000 OR v_n <> trunc(v_n) THEN PERFORM app.fail('MRS_INVALID', k); END IF;
        v_vals[i] := v_n::bigint;
      END IF;
    END LOOP;
    p.max_users := v_vals[1]; p.max_branches := v_vals[2]; p.max_tx_month := v_vals[3];
    p.max_storage_mb := v_vals[4]; p.max_messages_month := v_vals[5]; p.max_ai_runs_month := v_vals[6];
  END IF;
  IF p_payload ? 'price_monthly_sar' THEN
    IF jsonb_typeof(p_payload -> 'price_monthly_sar') = 'null' THEN
      p.price_monthly_sar := NULL;
    ELSE
      IF jsonb_typeof(p_payload -> 'price_monthly_sar') <> 'number' OR (p_payload ->> 'price_monthly_sar')::numeric < 0
         OR (p_payload ->> 'price_monthly_sar')::numeric > 9999999999.99 THEN
        PERFORM app.fail('MRS_INVALID', 'price_monthly_sar');
      END IF;
      p.price_monthly_sar := round((p_payload ->> 'price_monthly_sar')::numeric, 2);
    END IF;
  END IF;
  IF p_payload ? 'notes' THEN p.notes := app.ptext(p_payload, 'notes', 2000); END IF;
  p.updated_by := auth.uid();
  IF v_new THEN
    INSERT INTO public.plans (code, name_ar, name_en, sort, is_active, max_users, max_branches, max_tx_month, max_storage_mb,
                              max_messages_month, max_ai_runs_month, price_monthly_sar, notes, updated_by)
    VALUES (p.code, p.name_ar, p.name_en, p.sort, p.is_active, p.max_users, p.max_branches, p.max_tx_month, p.max_storage_mb,
            p.max_messages_month, p.max_ai_runs_month, p.price_monthly_sar, p.notes, p.updated_by)
    RETURNING * INTO p;
  ELSE
    UPDATE public.plans x SET name_ar = p.name_ar, name_en = p.name_en, sort = p.sort, is_active = p.is_active,
           max_users = p.max_users, max_branches = p.max_branches, max_tx_month = p.max_tx_month, max_storage_mb = p.max_storage_mb,
           max_messages_month = p.max_messages_month, max_ai_runs_month = p.max_ai_runs_month,
           price_monthly_sar = p.price_monthly_sar, notes = p.notes, updated_by = p.updated_by
     WHERE x.code = p.code RETURNING * INTO p;
  END IF;
  RETURN app.g7_plan_json(p) || jsonb_build_object('created', v_new);
END $$;

-- per org: metadata + subscription + usage counts only (never tenant rows, refs, client names or amounts)
CREATE OR REPLACE FUNCTION public.platform_list_subscriptions() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x.j ORDER BY x.created_at, x.id) FROM (
      SELECT o.id, o.created_at, (
        WITH u AS (SELECT app.g7_usage(o.id) j)
        SELECT jsonb_build_object(
          'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en, 'is_active', o.is_active,
          'plan_code', coalesce(s.plan_code, 'pilot'),
          'plan_name_ar', (SELECT p.name_ar FROM public.plans p WHERE p.code = coalesce(s.plan_code, 'pilot')),
          'plan_name_en', (SELECT p.name_en FROM public.plans p WHERE p.code = coalesce(s.plan_code, 'pilot')),
          'status', coalesce(s.status, 'active'), 'period_start', s.period_start, 'period_end', s.period_end,
          -- the server decides (same rule as app.g7_assert_active): a trial past its Asia/Riyadh end date refuses creates
          'trial_expired', (coalesce(s.status, 'active') = 'trial' AND (now() AT TIME ZONE 'Asia/Riyadh')::date > s.period_end),
          'limit_overrides', coalesce(s.limit_overrides, '{}'::jsonb), 'limits', app.g7_limits(o.id),
          'usage', u.j - 'over_limit', 'over_limit', u.j -> 'over_limit',
          'status_reason', s.status_reason, 'suspended_at', s.suspended_at, 'updated_at', s.updated_at) FROM u) j
        FROM public.organizations o
        LEFT JOIN public.org_subscriptions s ON s.org_id = o.id) x), '[]'::jsonb);
END $$;

-- {plan_code, status: trial|active, period_start, period_end?, limit_overrides?, reason} → {subscription, usage, over_limit[]}
CREATE OR REPLACE FUNCTION public.platform_set_org_plan(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions; n public.org_subscriptions; v_replay jsonb; v_plan public.plans; v_status text; v_reason text;
        v_ps date; v_pe date; v_ov jsonb; v_usage jsonb; v_res jsonb; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['plan_code','status','period_start','period_end','limit_overrides','reason']);
  v_replay := app.idem_begin('platform_set_org_plan', p_idem_key, jsonb_build_object('org', p_org, 'p', p_payload), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  s := app.g7_sub_lock(p_org);
  n := s;
  -- plan
  IF p_payload ? 'plan_code' THEN
    IF jsonb_typeof(p_payload -> 'plan_code') <> 'string' THEN PERFORM app.fail('MRS_INVALID', 'plan_code'); END IF;
    SELECT * INTO v_plan FROM public.plans p WHERE p.code = p_payload ->> 'plan_code';
    IF v_plan.code IS NULL THEN PERFORM app.fail('MRS_INVALID', 'plan_code'); END IF;
    IF NOT v_plan.is_active AND v_plan.code <> s.plan_code THEN PERFORM app.fail('MRS_INVALID', 'plan_inactive'); END IF;
    n.plan_code := v_plan.code;
  END IF;
  -- status
  IF p_payload ? 'status' THEN
    v_status := p_payload ->> 'status';
    IF v_status IN ('suspended','cancelled') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'use_suspend'); END IF;
    IF v_status IS NULL OR v_status NOT IN ('trial','active') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    n.status := v_status;
  END IF;
  -- period
  BEGIN
    IF p_payload ? 'period_start' THEN
      IF jsonb_typeof(p_payload -> 'period_start') <> 'string' OR btrim(p_payload ->> 'period_start') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'bad';
      END IF;
      v_ps := (btrim(p_payload ->> 'period_start'))::date;
      n.period_start := v_ps;
    END IF;
    IF p_payload ? 'period_end' THEN
      IF jsonb_typeof(p_payload -> 'period_end') = 'null' OR btrim(coalesce(p_payload ->> 'period_end', '')) = '' THEN
        n.period_end := NULL;
      ELSE
        IF jsonb_typeof(p_payload -> 'period_end') <> 'string' OR btrim(p_payload ->> 'period_end') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
          RAISE EXCEPTION 'bad';
        END IF;
        v_pe := (btrim(p_payload ->> 'period_end'))::date;
        n.period_end := v_pe;
      END IF;
    END IF;
  EXCEPTION WHEN others THEN
    PERFORM app.fail('MRS_INVALID', 'period');
  END;
  IF n.period_end IS NOT NULL AND n.period_end < n.period_start THEN PERFORM app.fail('MRS_INVALID', 'period'); END IF;
  IF n.status = 'trial' AND n.period_end IS NULL THEN PERFORM app.fail('MRS_INVALID', 'period'); END IF;
  -- overrides (replace as a whole)
  IF p_payload ? 'limit_overrides' THEN
    v_ov := CASE WHEN jsonb_typeof(p_payload -> 'limit_overrides') = 'null' THEN '{}'::jsonb ELSE p_payload -> 'limit_overrides' END;
    IF NOT app.g7_overrides_valid(v_ov) THEN PERFORM app.fail('MRS_INVALID', 'limit_overrides'); END IF;
    n.limit_overrides := v_ov;
  END IF;
  -- reason
  IF jsonb_typeof(p_payload -> 'reason') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'reason'); END IF;
  v_reason := nullif(btrim(coalesce(p_payload ->> 'reason', '')), '');
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  -- a suspended / cancelled subscription is re-activated first
  IF s.status IN ('suspended','cancelled') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'org_suspended'); END IF;

  UPDATE public.org_subscriptions x
     SET plan_code = n.plan_code, status = n.status, period_start = n.period_start, period_end = n.period_end,
         limit_overrides = n.limit_overrides, status_reason = v_reason, updated_by = v_uid
   WHERE x.org_id = p_org RETURNING * INTO n;
  v_usage := app.g7_usage(p_org);
  IF n.plan_code IS DISTINCT FROM s.plan_code THEN
    INSERT INTO public.subscription_events (org_id, actor, action, from_plan, to_plan, from_status, to_status, reason, detail)
    VALUES (p_org, v_uid, 'plan_changed', s.plan_code, n.plan_code, s.status, n.status, v_reason,
            jsonb_build_object('limits', app.g7_limits(p_org), 'usage', v_usage));
  END IF;
  IF n.limit_overrides IS DISTINCT FROM s.limit_overrides THEN
    INSERT INTO public.subscription_events (org_id, actor, action, from_plan, to_plan, reason, detail)
    VALUES (p_org, v_uid, 'limits_changed', s.plan_code, n.plan_code, v_reason,
            jsonb_build_object('from', s.limit_overrides, 'to', n.limit_overrides, 'usage', v_usage));
  END IF;
  IF n.period_start IS DISTINCT FROM s.period_start OR n.period_end IS DISTINCT FROM s.period_end THEN
    INSERT INTO public.subscription_events (org_id, actor, action, from_plan, to_plan, reason, detail)
    VALUES (p_org, v_uid, 'period_changed', s.plan_code, n.plan_code, v_reason,
            jsonb_build_object('from', jsonb_build_object('start', s.period_start, 'end', s.period_end),
                               'to', jsonb_build_object('start', n.period_start, 'end', n.period_end)));
  END IF;
  IF n.status IS DISTINCT FROM s.status THEN
    INSERT INTO public.subscription_events (org_id, actor, action, from_plan, to_plan, from_status, to_status, reason)
    VALUES (p_org, v_uid, 'status_changed', s.plan_code, n.plan_code, s.status, n.status, v_reason);
  END IF;
  v_res := jsonb_build_object('subscription', app.g7_sub_json(n), 'usage', v_usage - 'over_limit', 'over_limit', v_usage -> 'over_limit');
  RETURN app.idem_finish('platform_set_org_plan', p_idem_key, v_res);
END $$;

-- status → suspended (or cancelled) + organizations.is_active = false (G7-1: the G2 cutoff, data kept)
CREATE OR REPLACE FUNCTION public.platform_suspend_org(p_org uuid, p_reason text, p_cancel boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions; n public.org_subscriptions; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
        v_target text := CASE WHEN coalesce(p_cancel, false) THEN 'cancelled' ELSE 'suspended' END; v_active boolean;
        v_msg_jobs int := 0; v_bill_jobs int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  SELECT o.is_active INTO v_active FROM public.organizations o WHERE o.id = p_org FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  s := app.g7_sub_lock(p_org);
  IF s.status = v_target AND NOT v_active THEN
    RETURN jsonb_build_object('org_id', p_org, 'status', s.status, 'is_active', false, 'unchanged', true);
  END IF;
  UPDATE public.org_subscriptions x
     SET status = v_target, status_reason = v_reason, suspended_at = CASE WHEN s.status = v_target THEN s.suspended_at ELSE now() END,
         suspended_by = CASE WHEN s.status = v_target THEN s.suspended_by ELSE auth.uid() END, updated_by = auth.uid()
   WHERE x.org_id = p_org RETURNING * INTO n;
  IF v_active THEN UPDATE public.organizations o SET is_active = false WHERE o.id = p_org; END IF;
  -- review fix (queued work of a suspended org): the org's waiting worker jobs (messaging sends / drafts / polls, Daftra
  -- pushes) are PAUSED, never cancelled: next_run_at = 'infinity' keeps them out of msg_claim_jobs / daftra_claim_jobs
  -- (both claim only next_run_at <= now()); platform_activate_org releases exactly these. Jobs already running finish
  -- their lease. Service-role ingest of new inbound mail is not refused (owner decision, G7-1 open issue).
  UPDATE public.msg_jobs j SET next_run_at = 'infinity'
   WHERE j.org_id = p_org AND j.status IN ('queued','unknown') AND j.next_run_at <> 'infinity';
  GET DIAGNOSTICS v_msg_jobs = ROW_COUNT;
  UPDATE public.billing_sync_jobs j SET next_run_at = 'infinity'
   WHERE j.org_id = p_org AND j.status IN ('queued','unknown') AND j.next_run_at <> 'infinity';
  GET DIAGNOSTICS v_bill_jobs = ROW_COUNT;
  INSERT INTO public.subscription_events (org_id, actor, action, from_plan, to_plan, from_status, to_status, reason, detail)
  VALUES (p_org, auth.uid(), v_target, s.plan_code, s.plan_code, s.status, v_target, v_reason,
          jsonb_build_object('org_was_active', v_active, 'paused_msg_jobs', v_msg_jobs, 'paused_billing_jobs', v_bill_jobs));
  RETURN jsonb_build_object('org_id', p_org, 'status', n.status, 'is_active', false, 'unchanged', false,
                            'subscription', app.g7_sub_json(n));
END $$;

-- status → active, is_active = true (the only path past the G7-14 guard), suspended_at / by cleared
CREATE OR REPLACE FUNCTION public.platform_activate_org(p_org uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions; n public.org_subscriptions; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_active boolean;
        v_msg_jobs int := 0; v_bill_jobs int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  SELECT o.is_active INTO v_active FROM public.organizations o WHERE o.id = p_org FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  s := app.g7_sub_lock(p_org);
  IF s.status = 'active' AND v_active THEN
    RETURN jsonb_build_object('org_id', p_org, 'status', s.status, 'is_active', true, 'unchanged', true);
  END IF;
  UPDATE public.org_subscriptions x
     SET status = 'active', status_reason = v_reason, suspended_at = NULL, suspended_by = NULL, updated_by = auth.uid()
   WHERE x.org_id = p_org RETURNING * INTO n;
  IF NOT v_active THEN
    PERFORM set_config('app.g7_activating', 'on', true);
    UPDATE public.organizations o SET is_active = true WHERE o.id = p_org;
    PERFORM set_config('app.g7_activating', 'off', true);
  END IF;
  -- release the worker jobs paused by platform_suspend_org (each claim re-checks its job as usual)
  UPDATE public.msg_jobs j SET next_run_at = now()
   WHERE j.org_id = p_org AND j.status IN ('queued','unknown') AND j.next_run_at = 'infinity';
  GET DIAGNOSTICS v_msg_jobs = ROW_COUNT;
  UPDATE public.billing_sync_jobs j SET next_run_at = now()
   WHERE j.org_id = p_org AND j.status IN ('queued','unknown') AND j.next_run_at = 'infinity';
  GET DIAGNOSTICS v_bill_jobs = ROW_COUNT;
  INSERT INTO public.subscription_events (org_id, actor, action, from_plan, to_plan, from_status, to_status, reason, detail)
  VALUES (p_org, auth.uid(), 'activated', s.plan_code, s.plan_code, s.status, 'active', v_reason,
          jsonb_build_object('org_was_active', v_active, 'released_msg_jobs', v_msg_jobs, 'released_billing_jobs', v_bill_jobs));
  RETURN jsonb_build_object('org_id', p_org, 'status', n.status, 'is_active', true, 'unchanged', false,
                            'subscription', app.g7_sub_json(n));
END $$;

CREATE OR REPLACE FUNCTION public.platform_org_usage(p_org uuid, p_months int DEFAULT 6) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_cur date := app.g7_period(now());
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF p_months IS NULL OR p_months < 1 OR p_months > 24 THEN PERFORM app.fail('MRS_INVALID', 'months'); END IF;
  RETURN jsonb_build_object(
    'org_id', p_org,
    'limits', app.g7_limits(p_org),
    'current', app.g7_usage(p_org),
    'history', (SELECT jsonb_agg(jsonb_build_object('period_start', g.p,
                  'transactions_month', app.g7_counter(p_org, 'transactions_month', g.p),
                  'messages_month', app.g7_counter(p_org, 'messages_month', g.p),
                  'ai_runs_month', app.g7_counter(p_org, 'ai_runs_month', g.p)) ORDER BY g.p DESC)
                  FROM (SELECT (v_cur - make_interval(months => i))::date p FROM generate_series(0, p_months - 1) i) g),
    'storage_mb', app.g7_used(p_org, 'storage_mb'),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor', e.actor, 'action', e.action,
                  'from_plan', e.from_plan, 'to_plan', e.to_plan, 'from_status', e.from_status, 'to_status', e.to_status,
                  'reason', e.reason, 'detail', e.detail) ORDER BY e.at DESC, e.id)
                  FROM (SELECT * FROM public.subscription_events x WHERE x.org_id = p_org ORDER BY x.at DESC, x.id LIMIT 50) e), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.platform_recount_usage(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  -- exclusive usage lock FIRST (before any row lock: no lock-order inversion with a bumping transaction), so the
  -- before / after values and the recount itself see every bump of this org that was in flight (review fix)
  PERFORM pg_advisory_xact_lock(hashtext('marsa.g7.usage'), hashtext(p_org::text));
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  PERFORM app.g7_sub_lock(p_org);
  v_before := app.g7_usage(p_org) || jsonb_build_object('storage_bytes', app.g7_used(p_org, 'storage_bytes'));
  PERFORM app.g7_recount(p_org);
  v_after := app.g7_usage(p_org) || jsonb_build_object('storage_bytes', app.g7_used(p_org, 'storage_bytes'));
  INSERT INTO public.subscription_events (org_id, actor, action, detail)
  VALUES (p_org, auth.uid(), 'recounted', jsonb_build_object('before', v_before, 'after', v_after));
  RETURN jsonb_build_object('org_id', p_org, 'before', v_before, 'after', v_after, 'changed', v_before IS DISTINCT FROM v_after,
                            'usage', v_after - 'over_limit' - 'storage_bytes', 'over_limit', v_after -> 'over_limit');
END $$;

-- org admin of p_org only (no price, no events); everyone else (other roles, platform admins) → MRS_NOT_FOUND
CREATE OR REPLACE FUNCTION public.org_subscription(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.org_subscriptions; v_usage jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  SELECT * INTO s FROM public.org_subscriptions x WHERE x.org_id = p_org;
  v_usage := app.g7_usage(p_org);
  RETURN jsonb_build_object('plan_code', coalesce(s.plan_code, 'pilot'),
           'plan_name_ar', (SELECT p.name_ar FROM public.plans p WHERE p.code = coalesce(s.plan_code, 'pilot')),
           'plan_name_en', (SELECT p.name_en FROM public.plans p WHERE p.code = coalesce(s.plan_code, 'pilot')),
           'status', coalesce(s.status, 'active'), 'period_start', s.period_start, 'period_end', s.period_end,
           'limits', app.g7_limits(p_org), 'usage', v_usage - 'over_limit', 'over_limit', v_usage -> 'over_limit');
END $$;

-- ---------------------------------------------------------------------
-- 5. RLS (no policy, no API grant), audit, append-only, privileges
-- ---------------------------------------------------------------------
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans','org_subscriptions','subscription_events','org_usage_counters'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $rls$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['plans','org_subscriptions','subscription_events','org_usage_counters']) t;

DO $aud$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans','org_subscriptions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
END $aud$;
DROP TRIGGER IF EXISTS trg_append_only ON public.subscription_events;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.subscription_events FOR EACH ROW EXECUTE FUNCTION app.g7_tg_append_only();
DROP TRIGGER IF EXISTS trg_append_only_trunc ON public.subscription_events;
CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON public.subscription_events FOR EACH STATEMENT EXECUTE FUNCTION app.g7_tg_append_only();

-- every G7 app.* helper / trigger function: revoked from everyone (SECURITY DEFINER callers and triggers run them)
DO $fp$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.proname LIKE 'g7\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $fp$;

-- the 9 RPCs: authenticated only (each checks platform admin / org admin itself)
REVOKE ALL ON FUNCTION
  public.platform_list_plans(), public.platform_save_plan(text, jsonb), public.platform_list_subscriptions(),
  public.platform_set_org_plan(uuid, jsonb, uuid), public.platform_suspend_org(uuid, text, boolean),
  public.platform_activate_org(uuid, text), public.platform_org_usage(uuid, int), public.platform_recount_usage(uuid),
  public.org_subscription(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.platform_list_plans(), public.platform_save_plan(text, jsonb), public.platform_list_subscriptions(),
  public.platform_set_org_plan(uuid, jsonb, uuid), public.platform_suspend_org(uuid, text, boolean),
  public.platform_activate_org(uuid, text), public.platform_org_usage(uuid, int), public.platform_recount_usage(uuid),
  public.org_subscription(uuid)
TO authenticated;
