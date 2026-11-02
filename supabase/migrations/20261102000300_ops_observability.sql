-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261102000300 — G2.9, G2.12–G2.14
-- idempotency rollout, observability, schema versions (docs/online/G2_SPEC.md).
--
-- 1. public.schema_versions: one row per migration file (backfilled here for
--    every file up to and including this one). Read only via health_check().
-- 2. health_check()            anon + authenticated → {ok, db_time, schema_version, environment}
--                              (nothing tenant-specific).
-- 3. public.client_errors + log_client_error(p_payload) anon + authenticated.
--    Fields truncated, e-mails / phone numbers / long digit runs / JWTs /
--    tokens scrubbed BEFORE storage, rate limited (20 per user-or-visitor,
--    300 for all visitors together, 500 global per 10 minutes → silently
--    {logged:false}; the visitor key is the edge-set / right-most forwarded IP). Bad input never
--    raises, except an oversized payload (MRS_TOO_LONG).
--    Readers: admin_recent_errors(p_org) (org admin), platform_recent_errors()
--    (platform admin).
-- 4. admin_audit_log(p_org, p_filters) — paginated audit reader with actor
--    e-mail; org admin + supervisor (same as the audit_select policy).
-- 5. Idempotency (app.idem_* from 20261102000100) on submit_service_request,
--    submit_contact_message (payload.idempotencyKey), convert_request_to_transaction,
--    set_transaction_status, set_financial_status, issue_tracking_token
--    (new optional LAST parameter p_idem_key uuid DEFAULT NULL; the old
--    signatures are dropped first so PostgREST sees one function per name).
--    Bodies are copied from their latest definition (set_transaction_status
--    from 20261102000200, with branch_manager); only the idempotency lines are
--    new. Tracking tokens are NEVER stored in idempotency_keys.response: a
--    replay returns tracking_token / token NULL and token_shown:true.
--
-- NOTE: re-running 20261102000200 on its own AFTER this file re-creates the
-- 3-argument set_transaction_status next to the 4-argument one (ambiguous
-- calls). Always re-run the migrations in order (0200 then 0300).
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. schema versions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_versions (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{14}$'),
  name       text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,80}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.schema_versions IS 'G2.14: one row per applied migration file (supabase/migrations/<version>_<name>.sql). Read via health_check().';
ALTER TABLE public.schema_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.schema_versions FROM anon, authenticated;
-- no policies: API roles read the max version through health_check() only

-- backfill: every migration file so far (each later migration adds its own row)
INSERT INTO public.schema_versions (version, name) VALUES
  ('20261031000100', 'core_tenancy'),
  ('20261031000200', 'operations'),
  ('20261031000300', 'security_rls'),
  ('20261031000400', 'rpc'),
  ('20261031000500', 'storage'),
  ('20261031000650', 'admin_rpcs'),
  ('20261031000700', 'security_hardening'),
  ('20261101000100', 'document_extractions'),
  ('20261102000100', 'idempotency'),
  ('20261102000200', 'orgs_branches_invites'),
  ('20261102000300', 'ops_observability')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. health check (deliberately anon: no auth.uid() check, no tenant data)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.health_check() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('ok', true, 'db_time', now(),
                            'schema_version', (SELECT max(v.version) FROM public.schema_versions v),
                            'environment', 'staging')
$$;

-- ---------------------------------------------------------------------
-- 3. client error log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_errors (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES public.organizations(id) ON DELETE CASCADE,  -- only when the caller is a member
  user_id    uuid,                                                          -- NULL for visitors
  actor_key  text NOT NULL CHECK (actor_key ~ '^[0-9a-f]{64}$'),           -- sha256 of user / visitor (rate limit; no raw IP)
  page       text CHECK (char_length(page) <= 200),
  code       text CHECK (char_length(code) <= 60),
  message    text CHECK (char_length(message) <= 500),
  ua         text CHECK (char_length(ua) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.client_errors IS 'G2.12: scrubbed front-end errors (window.onerror). Written only by log_client_error(); read via admin_recent_errors / platform_recent_errors.';
CREATE INDEX IF NOT EXISTS client_errors_actor_idx ON public.client_errors (actor_key, created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_created_idx ON public.client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_org_idx ON public.client_errors (org_id, created_at DESC);
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_errors FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.client_errors_id_seq FROM anon, authenticated;
-- no policies: API roles never read or write this table directly

-- Removes personal data / secrets from free text, then truncates.
-- Order matters: JWTs and tokens before e-mails, hex before digit runs.
CREATE OR REPLACE FUNCTION app.scrub_text(p text, p_max int) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := left(app.to_western(coalesce(p, '')), 4000);   -- bound the regex work
BEGIN
  v := regexp_replace(v, '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g');
  v := regexp_replace(v, 'eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]*)?', '[jwt]', 'g');
  v := regexp_replace(v, '(bearer|apikey|authorization)([[:space:]]*[:=]?[[:space:]]*)[A-Za-z0-9._~+/=-]{8,}', '\1\2[secret]', 'gi');
  v := regexp_replace(v, '(token|invite|access_token|refresh_token|apikey|key|password|secret|code)=[^&[:space:]#"'']+', '\1=[redacted]', 'gi');
  v := regexp_replace(v, '\m(sb_secret_|sb_publishable_|sk_|pk_)[A-Za-z0-9_-]{8,}', '[secret]', 'g');
  v := regexp_replace(v, '%40', '@', 'gi');                     -- percent-encoded e-mails
  v := regexp_replace(v, '[^[:space:]@<>()"'',;:]+@[^[:space:]@<>()"'',;:]+\.[A-Za-z]{2,}', '[email]', 'g');
  v := regexp_replace(v, '[0-9A-Fa-f]{32,}', '[hex]', 'g');
  v := regexp_replace(v, '[A-Za-z0-9_-]{40,}', '[token]', 'g');
  -- Saudi IBAN (SA + 22, optionally grouped) before the '00…' phone rule (which would eat its check digits)
  v := regexp_replace(v, '\mSA[0-9]{2}([ ]?[0-9A-Za-z]){20}\M', '[iban]', 'gi');
  -- phone numbers: international / Saudi forms with separators, then any long digit run
  v := regexp_replace(v, '(\+|00)[0-9][0-9 ().-]{6,}[0-9]', '[number]', 'g');
  v := regexp_replace(v, '\m0?5[0-9]([ .-]?[0-9]){7}\M', '[number]', 'g');
  -- 8+ digits split by spaces / dashes (cards, landlines, spaced IDs). '.' is not a
  -- separator here (versions / IPs stay readable); ISO dates are masked too — accepted.
  v := regexp_replace(v, '[0-9]([ -]?[0-9]){7,}', '[number]', 'g');
  v := regexp_replace(v, '[0-9]{6,}', '[number]', 'g');
  v := nullif(btrim(v), '');
  RETURN left(v, p_max);
END $$;

CREATE OR REPLACE FUNCTION public.log_client_error(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_who   text;
  v_actor text;
  v_page  text;
  v_code  text;
  v_msg   text;
  v_ua    text;
  v_h     jsonb;
  v_xff   text[];
BEGIN
  -- deliberately callable by visitors: no auth check. Only an oversized payload raises.
  IF p_payload IS NOT NULL AND length(p_payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RETURN jsonb_build_object('logged', false); END IF;

  -- who: signed-in user, else the visitor's IP, else the page's random visitor id (hashed, never stored raw).
  -- The IP comes from what the edge sets (cf-connecting-ip / x-real-ip) or the RIGHT-most
  -- X-Forwarded-For hop (appended by the proxy). The left-most hop is client-controlled
  -- and would let one visitor rotate past the per-visitor limit.
  IF v_uid IS NOT NULL THEN
    v_who := 'u:' || v_uid::text;
  ELSE
    BEGIN
      v_h := current_setting('request.headers', true)::jsonb;
      v_xff := string_to_array(v_h ->> 'x-forwarded-for', ',');
      v_who := coalesce(nullif(btrim(v_h ->> 'cf-connecting-ip'), ''), nullif(btrim(v_h ->> 'x-real-ip'), ''),
                        nullif(btrim(v_xff[array_length(v_xff, 1)]), ''));
      IF v_who !~ '^[0-9A-Fa-f:.]{3,45}$' THEN v_who := NULL; END IF;
    EXCEPTION WHEN others THEN v_who := NULL;
    END;
    v_who := coalesce('ip:' || v_who,
                      'v:' || CASE WHEN (p_payload ->> 'visitorId') ~* '^[0-9a-f-]{36}$' THEN lower(p_payload ->> 'visitorId') END,
                      'anon');
  END IF;
  v_actor := app.hash_token(v_who);

  -- rate limits: drop silently (the page must not retry or learn anything).
  -- Visitors share a smaller budget (300) so they can never starve signed-in errors.
  IF (SELECT count(*) FROM public.client_errors e
       WHERE e.actor_key = v_actor AND e.created_at > now() - interval '10 minutes') >= 20
     OR (SELECT count(*) FROM public.client_errors e WHERE e.created_at > now() - interval '10 minutes') >= 500
     OR (v_uid IS NULL AND (SELECT count(*) FROM public.client_errors e
                             WHERE e.user_id IS NULL AND e.created_at > now() - interval '10 minutes') >= 300) THEN
    RETURN jsonb_build_object('logged', false);
  END IF;

  -- org only when the caller is an active member (visitors cannot attribute errors to a tenant)
  IF v_uid IS NOT NULL AND (p_payload ->> 'orgId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND app.is_member((p_payload ->> 'orgId')::uuid) THEN
    v_org := (p_payload ->> 'orgId')::uuid;
  END IF;

  -- page: path only (query string / fragment may carry tokens)
  v_page := app.scrub_text(split_part(split_part(CASE WHEN jsonb_typeof(p_payload -> 'page') = 'string' THEN p_payload ->> 'page' END,
                                                 '?', 1), '#', 1), 200);
  v_code := left(nullif(regexp_replace(CASE WHEN jsonb_typeof(p_payload -> 'code') IN ('string','number') THEN p_payload ->> 'code' END,
                                       '[^A-Za-z0-9_.:-]', '', 'g'), ''), 60);
  v_msg  := app.scrub_text(CASE WHEN jsonb_typeof(p_payload -> 'message') = 'string' THEN p_payload ->> 'message' END, 500);
  v_ua   := app.scrub_text(CASE WHEN jsonb_typeof(p_payload -> 'ua') = 'string' THEN p_payload ->> 'ua' END, 200);
  IF v_msg IS NULL AND v_code IS NULL THEN RETURN jsonb_build_object('logged', false); END IF;

  INSERT INTO public.client_errors (org_id, user_id, actor_key, page, code, message, ua)
  VALUES (v_org, v_uid, v_actor, v_page, v_code, v_msg, v_ua);
  RETURN jsonb_build_object('logged', true);
END $$;

-- housekeeping (call from a scheduled job; never from the API)
CREATE OR REPLACE FUNCTION app.client_errors_purge(p_days int DEFAULT 30) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM public.client_errors e WHERE e.created_at < now() - make_interval(days => greatest(p_days, 1)) RETURNING 1)
  SELECT count(*)::int FROM d
$$;

-- Daily housekeeping when pg_cron is enabled (Supabase: Database → Extensions → pg_cron).
-- Without pg_cron (local PGlite, tests) nothing happens; docs/online/ENVIRONMENTS_AR.md
-- lists the manual fallback. cron.schedule(name, …) replaces a job of the same name.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.schedule('marsa_idem_purge', '17 3 * * *', 'SELECT app.idem_purge_expired()')$q$;
    EXECUTE $q$SELECT cron.schedule('marsa_client_errors_purge', '27 3 * * *', 'SELECT app.client_errors_purge(30)')$q$;
  END IF;
END $cron$;

-- latest 200 errors of one org (org admin only)
CREATE OR REPLACE FUNCTION public.admin_recent_errors(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', x.id, 'created_at', x.created_at, 'page', x.page, 'code', x.code, 'message', x.message,
             'ua', x.ua, 'user_id', x.user_id, 'user_email', u.email) ORDER BY x.id DESC)
      FROM (SELECT * FROM public.client_errors e WHERE e.org_id = p_org ORDER BY e.id DESC LIMIT 200) x
      LEFT JOIN auth.users u ON u.id = x.user_id), '[]'::jsonb);
END $$;

-- latest 200 errors platform-wide (platform admin only). No user identity:
-- the platform operator manages organizations, not tenant users.
CREATE OR REPLACE FUNCTION public.platform_recent_errors() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', x.id, 'created_at', x.created_at, 'org_id', x.org_id, 'org_slug', o.slug,
             'page', x.page, 'code', x.code, 'message', x.message, 'ua', x.ua,
             'signed_in', x.user_id IS NOT NULL) ORDER BY x.id DESC)
      FROM (SELECT * FROM public.client_errors e ORDER BY e.id DESC LIMIT 200) x
      LEFT JOIN public.organizations o ON o.id = x.org_id), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------
-- 4. audit log reader
--    p_filters: {table_name?, actor? (uuid), from?, to? (timestamptz), row_id?,
--                limit? (1..200, default 50), before_id? (keyset pagination)}
--    → {items:[…], next_before_id (NULL on the last page)}
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS audit_log_org_id_idx ON public.audit_log (org_id, id DESC);

CREATE OR REPLACE FUNCTION public.admin_audit_log(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_table text;
  v_actor uuid;
  v_from  timestamptz;
  v_to    timestamptz;
  v_row   text;
  v_limit int := 50;
  v_before bigint;
  v_items jsonb;
  v_n     int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  -- same readers as the audit_select policy; branch_manager is not one of them
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','supervisor']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(f, ARRAY['table_name','actor','from','to','row_id','limit','before_id']);

  v_table := app.ptext(f, 'table_name', 63);
  IF v_table !~ '^[a-z_]{1,63}$' THEN PERFORM app.fail('MRS_INVALID', 'table_name'); END IF;
  v_actor := app.puuid(f, 'actor');
  v_row := app.ptext(f, 'row_id', 100);
  BEGIN
    v_from := nullif(btrim(coalesce(f ->> 'from', '')), '')::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', 'from');
  END;
  BEGIN
    v_to := nullif(btrim(coalesce(f ->> 'to', '')), '')::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', 'to');
  END;
  IF f ? 'limit' AND f ->> 'limit' IS NOT NULL THEN
    IF (f ->> 'limit') !~ '^[0-9]{1,6}$' THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
    v_limit := least(greatest((f ->> 'limit')::int, 1), 200);
  END IF;
  IF f ? 'before_id' AND f ->> 'before_id' IS NOT NULL THEN
    IF (f ->> 'before_id') !~ '^[0-9]{1,18}$' THEN PERFORM app.fail('MRS_INVALID', 'before_id'); END IF;
    v_before := (f ->> 'before_id')::bigint;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'at', x.at, 'table_name', x.table_name, 'row_id', x.row_id, 'action', x.action,
           'changed_fields', to_jsonb(x.changed_fields), 'old_data', x.old_data, 'new_data', x.new_data,
           'actor', x.actor, 'actor_email', u.email, 'actor_role', x.actor_role) ORDER BY x.id DESC), '[]'::jsonb),
         count(*)
    INTO v_items, v_n
    FROM (SELECT a.* FROM public.audit_log a
           WHERE a.org_id = p_org
             AND (v_table IS NULL OR a.table_name = v_table)
             AND (v_actor IS NULL OR a.actor = v_actor)
             AND (v_row IS NULL OR a.row_id = v_row)
             AND (v_from IS NULL OR a.at >= v_from)
             AND (v_to IS NULL OR a.at < v_to)
             AND (v_before IS NULL OR a.id < v_before)
           ORDER BY a.id DESC
           LIMIT v_limit) x
    LEFT JOIN auth.users u ON u.id = x.actor;

  RETURN jsonb_build_object('items', v_items,
    'next_before_id', CASE WHEN v_n = v_limit THEN (SELECT min((i ->> 'id')::bigint) FROM jsonb_array_elements(v_items) i) END);
END $$;

-- ---------------------------------------------------------------------
-- 5. idempotency rollout
-- ---------------------------------------------------------------------
-- submit_service_request (signature unchanged; key in payload.idempotencyKey)
CREATE OR REPLACE FUNCTION public.submit_service_request(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
  v_uid uuid := auth.uid();
  v_client uuid;
  v_res record;
  v_key uuid;
  v_replay jsonb;
  v_out jsonb;
BEGIN
  -- replay BEFORE the open/active gate: a committed submission whose response was lost
  -- still replays after intake is closed (unknown slug → the same MRS_INTAKE_CLOSED)
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea');
  IF v_org.id IS NULL THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  v_key := app.idem_key_from(payload);
  v_replay := app.idem_begin('submit_service_request', v_key, payload, v_org.id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT v_org.is_active OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;

  -- a signed-in client may attach the request to one of their own client records
  IF v_uid IS NOT NULL AND (payload ->> 'clientId') ~ '^[0-9a-f-]{36}$' THEN
    SELECT c.id INTO v_client FROM public.clients c
     WHERE c.id = (payload ->> 'clientId')::uuid AND c.org_id = v_org.id AND app.is_client_user(c.id);
  END IF;

  SELECT * INTO v_res FROM app.insert_service_request(
    v_org.id, payload, CASE WHEN v_uid IS NULL THEN 'web' ELSE 'portal' END, v_uid, v_client, NULL);

  -- the stored replay copy never holds the tracking token
  v_out := jsonb_build_object('ref', v_res.ref, 'tracking_token', NULL, 'token', NULL, 'token_shown', true,
                              'status', 'new', 'created_at', now(), 'environment', v_org.environment);
  PERFORM app.idem_finish('submit_service_request', v_key, v_out);
  RETURN (v_out - 'token') || jsonb_build_object('tracking_token', v_res.token, 'token_shown', false);
END $$;

-- submit_contact_message (signature unchanged; key in payload.idempotencyKey).
-- The replay check runs before the intake gate and the rate guards, so a retry is
-- never rate limited and still replays after intake was closed.
CREATE OR REPLACE FUNCTION public.submit_contact_message(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
  v_phone text;
  v_email text;
  v_subject text;
  v_pref text;
  v_ref text;
  v_key uuid;
  v_replay jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  IF length(payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea');
  IF v_org.id IS NULL THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  v_key := app.idem_key_from(payload);
  v_replay := app.idem_begin('submit_contact_message', v_key, payload, v_org.id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT v_org.is_active OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;

  IF char_length(app.ptext(payload, 'name', 120, true)) < 3 THEN PERFORM app.fail('MRS_INVALID', 'name'); END IF;
  v_phone := app.norm_phone(app.ptext(payload, 'phone', 25, true), true);
  IF v_phone IS NULL THEN PERFORM app.fail('MRS_INVALID', 'phone'); END IF;
  v_email := lower(app.ptext(payload, 'email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  v_subject := app.ptext(payload, 'subject', 20, true);
  IF v_subject NOT IN ('quote','aci','saber','hs','duties','tracking','export','partnership','complaint','other') THEN
    PERFORM app.fail('MRS_INVALID', 'subject');
  END IF;
  IF char_length(app.ptext(payload, 'message', 1000, true)) < 15 THEN PERFORM app.fail('MRS_INVALID', 'message'); END IF;
  v_pref := coalesce(app.ptext(payload, 'preferred', 20), 'phone');
  IF v_pref NOT IN ('phone','whatsapp','email') THEN PERFORM app.fail('MRS_INVALID', 'preferred'); END IF;
  IF NOT app.pbool(payload, 'consent') THEN PERFORM app.fail('MRS_REQUIRED', 'consent'); END IF;

  IF (SELECT count(*) FROM public.contact_messages m
       WHERE m.org_id = v_org.id AND m.phone = v_phone AND m.created_at > now() - interval '1 hour') >= 5 THEN
    PERFORM app.fail('MRS_RATE_LIMITED', 'phone');
  END IF;
  IF (SELECT count(*) FROM public.contact_messages m
       WHERE m.org_id = v_org.id AND m.created_at > now() - interval '10 minutes') >= 120 THEN
    PERFORM app.fail('MRS_RATE_LIMITED', 'org');
  END IF;

  v_ref := app.next_ref(v_org.id, 'message');
  INSERT INTO public.contact_messages (org_id, ref, name, company, phone, email, subject, reference, message, preferred, submitted_by)
  VALUES (v_org.id, v_ref, app.ptext(payload, 'name', 120), app.ptext(payload, 'company', 160), v_phone, v_email,
          v_subject, app.ptext(payload, 'reference', 40), app.ptext(payload, 'message', 1000), v_pref, auth.uid());
  RETURN app.idem_finish('submit_contact_message', v_key, jsonb_build_object('ref', v_ref, 'created_at', now()));
END $$;

-- convert_request_to_transaction (+ p_idem_key). The replay check runs after the
-- row lock and the access check, so a concurrent retry waits and then replays.
DROP FUNCTION IF EXISTS public.convert_request_to_transaction(uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.convert_request_to_transaction(
  p_request_id uuid, p_branch_id uuid DEFAULT NULL, p_client_id uuid DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req public.service_requests;
  v_branch uuid;
  v_client uuid;
  v_client_created boolean := false;
  v_tx public.transactions;
  v_no text;
  v_n int := 0;
  v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_req FROM public.service_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL OR NOT app.has_request_role(v_req.id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('convert_request', p_idem_key,
    jsonb_build_object('request_id', p_request_id, 'branch_id', p_branch_id, 'client_id', p_client_id), v_req.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_req.status = 'converted' OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.request_id = v_req.id) THEN
    PERFORM app.fail('MRS_ALREADY_CONVERTED');
  END IF;
  IF v_req.status = 'rejected' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'rejected'); END IF;

  v_branch := coalesce(p_branch_id, v_req.branch_id);
  IF v_branch IS NULL THEN PERFORM app.fail('MRS_BRANCH_REQUIRED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = v_req.org_id AND b.is_active)
     OR NOT app.has_branch_role(v_req.org_id, v_branch, app.ops_writer_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'branch');
  END IF;

  -- client master: explicit → request link → natural key (CR / VAT) → new record
  IF p_client_id IS NOT NULL THEN
    SELECT c.id INTO v_client FROM public.clients c WHERE c.id = p_client_id AND c.org_id = v_req.org_id;
    IF v_client IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  ELSIF v_req.client_id IS NOT NULL THEN
    v_client := v_req.client_id;
  ELSE
    SELECT c.id INTO v_client FROM public.clients c
     WHERE c.org_id = v_req.org_id
       AND ((v_req.cr_number IS NOT NULL AND c.cr_number = v_req.cr_number)
         OR (v_req.vat_number IS NOT NULL AND c.vat_number = v_req.vat_number))
     ORDER BY (c.cr_number = v_req.cr_number) DESC NULLS LAST LIMIT 1;
    IF v_client IS NULL THEN
      INSERT INTO public.clients (org_id, client_type, name_ar, contact_person, cr_number, vat_number, phone, email,
                                  preferred_contact, created_by, notes)
      VALUES (v_req.org_id, coalesce(v_req.client_type, 'business'),
              CASE WHEN v_req.client_type = 'individual' OR v_req.company IS NULL OR v_req.company = 'فرد'
                   THEN v_req.full_name ELSE v_req.company END,
              v_req.full_name, v_req.cr_number, v_req.vat_number, v_req.phone,
              CASE WHEN app.is_email(v_req.email) THEN v_req.email END,
              v_req.contact_pref, auth.uid(), 'أُنشئ من طلب الخدمة ' || v_req.ref)
      RETURNING id INTO v_client;
      v_client_created := true;
    END IF;
  END IF;

  INSERT INTO public.transactions (
    org_id, branch_id, client_id, request_id, operation, mode, service,
    port_of_loading, port_of_discharge, country, goods_description, hs_code, shipping_line, bl_number,
    declaration_no, container_count, package_count, eta, responsible_user_id, created_by)
  VALUES (
    v_req.org_id, v_branch, v_client, v_req.id, v_req.direction, v_req.mode, v_req.service,
    CASE WHEN v_req.direction = 'export' THEN v_req.port END,
    CASE WHEN v_req.direction = 'import' THEN v_req.port END,
    v_req.country, v_req.goods, v_req.hs_code, v_req.shipping_line, v_req.bl_number,
    v_req.declaration_no,
    greatest(coalesce(array_length(v_req.container_numbers, 1), 0),
             CASE WHEN v_req.count_kind = 'containers' THEN coalesce(v_req.declared_count, 0) ELSE 0 END),
    CASE WHEN v_req.count_kind = 'packages' THEN v_req.declared_count END,
    v_req.eta, auth.uid(), auth.uid())
  RETURNING * INTO v_tx;

  FOREACH v_no IN ARRAY v_req.container_numbers LOOP
    INSERT INTO public.containers (org_id, transaction_id, container_no, container_type)
    VALUES (v_req.org_id, v_tx.id, v_no, CASE WHEN v_req.container_type IN ('20ft','40ft') THEN v_req.container_type END)
    ON CONFLICT (transaction_id, container_no) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;

  -- documents uploaded against the request now also belong to the transaction (path unchanged)
  UPDATE public.documents d SET transaction_id = v_tx.id
   WHERE d.request_id = v_req.id AND d.transaction_id IS NULL;

  UPDATE public.service_requests r
     SET status = 'converted', client_id = v_client, branch_id = v_branch, reviewed_by = auth.uid(), reviewed_at = now()
   WHERE r.id = v_req.id;

  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
  VALUES (v_req.org_id, v_tx.id, 'request_converted', auth.uid(),
          jsonb_build_object('request_id', v_req.id, 'request_ref', v_req.ref, 'client_id', v_client,
                             'client_created', v_client_created, 'containers', v_n));

  RETURN app.idem_finish('convert_request', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'client_id', v_client,
                       'client_created', v_client_created, 'containers', v_n, 'request_ref', v_req.ref));
END $$;

-- set_transaction_status (+ p_idem_key; body = 20261102000200, branch_manager kept)
DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text);
CREATE OR REPLACE FUNCTION public.set_transaction_status(
  p_transaction_id uuid, p_status text, p_note text DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_from int; v_to int;
  v_roles text[];
  v_backward boolean;
  v_skip int;
  v_open int;
  v_ev bigint;
  v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('set_transaction_status', p_idem_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'status', p_status, 'note', p_note), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_to := app.code_sort('operational_status', p_status);
  v_from := app.code_sort('operational_status', v_tx.operational_status);
  IF v_to IS NULL THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_to = v_from THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  v_backward := v_to < v_from;

  v_roles := CASE p_status
    WHEN 'new'                    THEN ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
    WHEN 'in_progress'            THEN ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
    WHEN 'customs_declaration'    THEN ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
    WHEN 'appointment'            THEN app.transport_writer_roles()
    WHEN 'transport'              THEN app.transport_writer_roles()
    WHEN 'empty_return'           THEN app.transport_writer_roles()
    WHEN 'operationally_complete' THEN app.ops_writer_roles()
    WHEN 'under_billing'          THEN app.finance_roles()
    WHEN 'billed'                 THEN app.finance_roles()
    WHEN 'closed'                 THEN ARRAY['accounts_manager','supervisor','admin']
  END;
  IF v_backward THEN
    -- corrections never erase history: they add an event and need a reason + senior role
    IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED'); END IF;
    v_roles := CASE WHEN v_tx.operational_status = 'closed' THEN ARRAY['admin']
                    ELSE ARRAY['operations_manager','branch_manager','supervisor','admin'] END;
  END IF;
  -- operational completion needs per-container empty-return proof (or a documented waiver).
  -- Declared containers that were never registered count as "not returned" (no trivial pass with 0 rows).
  IF NOT v_backward AND v_to >= app.code_sort('operational_status', 'operationally_complete') THEN
    SELECT count(*) INTO v_open FROM public.containers c
     WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived');
    v_open := greatest(v_open, coalesce(v_tx.container_count, 0)
                               - (SELECT count(*) FROM public.containers c WHERE c.transaction_id = v_tx.id));
    IF v_open > 0 THEN PERFORM app.fail('MRS_CONTAINERS_NOT_RETURNED', v_open::text); END IF;
  END IF;

  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, v_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;

  -- stage order: forward moves go one stage at a time. The empty-return stage may be passed over
  -- when the transaction has no containers. Any other skip is an exception: senior role + reason.
  IF NOT v_backward AND v_to - v_from > 1 THEN
    v_skip := v_to - v_from - 1;
    IF v_from < app.code_sort('operational_status', 'empty_return') AND v_to > app.code_sort('operational_status', 'empty_return')
       AND coalesce(v_tx.container_count, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = v_tx.id) THEN
      v_skip := v_skip - 1;
    END IF;
    IF v_skip > 0 THEN
      IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, ARRAY['operations_manager','branch_manager','supervisor','admin']) THEN
        PERFORM app.fail('MRS_BAD_TRANSITION', 'stage_skip');
      END IF;
      IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED'); END IF;
    END IF;
  END IF;


  UPDATE public.transactions t SET operational_status = p_status, status_changed_at = now() WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'operational_status', v_tx.operational_status, p_status, true, auth.uid(),
          jsonb_build_object('direction', CASE WHEN v_backward THEN 'backward' ELSE 'forward' END))
  RETURNING id INTO v_ev;
  IF v_note IS NOT NULL THEN
    -- the reason is internal; status events visible to clients carry no free text
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
    VALUES (v_tx.org_id, v_tx.id, 'note', v_note, false, auth.uid(), jsonb_build_object('for_event', v_ev));
  END IF;
  RETURN app.idem_finish('set_transaction_status', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'from', v_tx.operational_status,
                       'to', p_status, 'event_id', v_ev));
END $$;

-- set_financial_status (+ p_idem_key) — PLACEHOLDER (no ledger/invoicing until G4)
DROP FUNCTION IF EXISTS public.set_financial_status(uuid, text, text);
CREATE OR REPLACE FUNCTION public.set_financial_status(
  p_transaction_id uuid, p_status text, p_note text DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ev bigint; v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('set_financial_status', p_idem_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'status', p_status, 'note', p_note), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT app.is_code('financial_status', p_status) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF p_status = v_tx.financial_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.finance_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF app.code_sort('financial_status', p_status) < app.code_sort('financial_status', v_tx.financial_status) AND v_note IS NULL THEN
    PERFORM app.fail('MRS_NOTE_REQUIRED');
  END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  UPDATE public.transactions t SET financial_status = p_status WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor)
  VALUES (v_tx.org_id, v_tx.id, 'financial_status', v_tx.financial_status, p_status, v_note, false, auth.uid())
  RETURNING id INTO v_ev;
  RETURN app.idem_finish('set_financial_status', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'from', v_tx.financial_status, 'to', p_status, 'event_id', v_ev));
END $$;

-- issue_tracking_token (+ p_idem_key). The token is returned once and never
-- stored (only its hash on the transaction); a replay says it was already shown.
DROP FUNCTION IF EXISTS public.issue_tracking_token(uuid);
CREATE OR REPLACE FUNCTION public.issue_tracking_token(p_transaction_id uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_token text := app.new_token(); v_replay jsonb; v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('issue_tracking_token', p_idem_key, jsonb_build_object('transaction_id', p_transaction_id), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  UPDATE public.transactions t SET tracking_token_hash = app.hash_token(v_token) WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'tracking_token', auth.uid(), jsonb_build_object('reissued', v_tx.tracking_token_hash IS NOT NULL));
  v_out := jsonb_build_object('ref', v_tx.ref, 'tracking_token', NULL, 'token', NULL, 'token_shown', true);
  PERFORM app.idem_finish('issue_tracking_token', p_idem_key, v_out);
  RETURN (v_out - 'token') || jsonb_build_object('tracking_token', v_token, 'token_shown', false);
END $$;

-- ---------------------------------------------------------------------
-- 6. privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.scrub_text(text, int), app.client_errors_purge(int) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.health_check(), public.log_client_error(jsonb), public.admin_recent_errors(uuid),
  public.platform_recent_errors(), public.admin_audit_log(uuid, jsonb),
  public.submit_service_request(jsonb), public.submit_contact_message(jsonb),
  public.convert_request_to_transaction(uuid, uuid, uuid, uuid), public.set_transaction_status(uuid, text, text, uuid),
  public.set_financial_status(uuid, text, text, uuid), public.issue_tracking_token(uuid, uuid)
FROM PUBLIC, anon, authenticated;

-- deliberately public (visitors): intake forms, health check, error beacon
GRANT EXECUTE ON FUNCTION
  public.health_check(), public.log_client_error(jsonb),
  public.submit_service_request(jsonb), public.submit_contact_message(jsonb)
TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.admin_recent_errors(uuid), public.platform_recent_errors(), public.admin_audit_log(uuid, jsonb),
  public.convert_request_to_transaction(uuid, uuid, uuid, uuid), public.set_transaction_status(uuid, text, text, uuid),
  public.set_financial_status(uuid, text, text, uuid), public.issue_tracking_token(uuid, uuid)
TO authenticated;

-- Re-run safety: G3 (20261103000200) replaces set_transaction_status(uuid, text, text, uuid) with a
-- 5-argument version (+ p_docs_override boolean DEFAULT false). If this file is re-run on its own after
-- G3, drop the 4-argument overload it just recreated (ambiguous calls, and it lacks the document gate).
DO $reruns$
BEGIN
  IF to_regprocedure('public.set_transaction_status(uuid, text, text, uuid, boolean)') IS NOT NULL THEN
    DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text, uuid);
  END IF;
END $reruns$;
