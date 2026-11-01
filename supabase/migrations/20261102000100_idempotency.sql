-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261102000100 — G2.13 request idempotency.
--
-- One row per (scope, key) that SUCCEEDED. A failed RPC rolls back its own
-- row together with everything else it did, so "no row" means "never
-- happened" and a retry with the same key is always safe. A retry of a
-- succeeded call returns the stored response instead of acting twice.
--
--   v := app.idem_begin(scope, key, payload)   -- NULL = go ahead, else = stored response
--   ... do the work ...
--   PERFORM app.idem_finish(scope, key, response);
--
-- Same key + different payload  → MRS_IDEMPOTENCY_CONFLICT (client bug).
-- Concurrent same key: the second INSERT waits on the first transaction's
-- unique-index lock, then sees its committed row and replays it.
-- Keys are client-generated UUIDs, kept by the page across retries until a
-- definite answer arrives (assets/js/supa.js).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  scope        text NOT NULL CHECK (scope ~ '^[a-z_]{2,40}$'),
  key          uuid NOT NULL,
  org_id       uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id      uuid,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON public.idempotency_keys (expires_at);
COMMENT ON TABLE public.idempotency_keys IS 'G2.13: replay store for idempotent RPCs. Written only by SECURITY DEFINER functions.';

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idempotency_keys FROM anon, authenticated;
-- no policies: API roles never read or write this table directly

-- Returns NULL when the caller should do the work, or the stored response
-- of an earlier successful call with the same key and payload.
-- p_key NULL = caller did not ask for idempotency (old clients) → always NULL.
CREATE OR REPLACE FUNCTION app.idem_begin(p_scope text, p_key uuid, p_payload jsonb, p_org uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8')), 'hex');
  v_row  public.idempotency_keys;
BEGIN
  IF p_key IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.idempotency_keys (scope, key, org_id, user_id, request_hash)
  VALUES (p_scope, p_key, p_org, auth.uid(), v_hash)
  ON CONFLICT (scope, key) DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;           -- first time: proceed

  SELECT * INTO v_row FROM public.idempotency_keys k WHERE k.scope = p_scope AND k.key = p_key;
  -- a key belongs to the user (or visitor) who first used it, in the org it was first used for
  -- (the same payload sent to another org must not replay the first org's result)
  IF v_row.user_id IS DISTINCT FROM auth.uid() OR v_row.org_id IS DISTINCT FROM p_org OR v_row.request_hash <> v_hash THEN
    PERFORM app.fail('MRS_IDEMPOTENCY_CONFLICT', 'idempotency_key');
  END IF;
  IF v_row.expires_at < now() THEN
    PERFORM app.fail('MRS_IDEMPOTENCY_CONFLICT', 'expired');
  END IF;
  IF v_row.completed_at IS NULL THEN
    -- unreachable in practice (same transaction re-entering); fail closed
    PERFORM app.fail('MRS_IN_PROGRESS', 'idempotency_key');
  END IF;
  RETURN v_row.response || jsonb_build_object('replayed', true);
END $$;

CREATE OR REPLACE FUNCTION app.idem_finish(p_scope text, p_key uuid, p_response jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_key IS NOT NULL THEN
    UPDATE public.idempotency_keys k
       SET response = p_response, completed_at = now()
     WHERE k.scope = p_scope AND k.key = p_key;
  END IF;
  RETURN p_response;
END $$;

-- payload helper: idempotency key carried inside a jsonb payload ("idempotencyKey")
CREATE OR REPLACE FUNCTION app.idem_key_from(p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := nullif(btrim(coalesce(p_payload ->> 'idempotencyKey', '')), '');
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM app.fail('MRS_INVALID', 'idempotency_key');
  END IF;
  RETURN v::uuid;
END $$;

-- housekeeping (call from a scheduled job; never from the API)
CREATE OR REPLACE FUNCTION app.idem_purge_expired() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM public.idempotency_keys k WHERE k.expires_at < now() - interval '1 day' RETURNING 1)
  SELECT count(*)::int FROM d
$$;

REVOKE EXECUTE ON FUNCTION app.idem_begin(text, uuid, jsonb, uuid), app.idem_finish(text, uuid, jsonb),
  app.idem_key_from(jsonb), app.idem_purge_expired() FROM PUBLIC, anon, authenticated;
