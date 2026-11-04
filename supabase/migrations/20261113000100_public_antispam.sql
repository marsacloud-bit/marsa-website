-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261113000100 — public anti-spam: per-IP rate limits + form signals (honeypot,
-- minimum fill time) on the public entry points, now that marsacloud.com is public (docs/online/ANTISPAM_AR.md).
-- Builds on the deployment environment (20261112000100). No external service, no new cron job.
--   P. preflight (deploy_env applied) + schema_versions row
--   0. tables       (schema app: not reachable through the API, no grant to any API role, RLS on, no policies)
--                   app.antispam_settings  one row: per-install salt (never returned), min_fill_ms (2500),
--                                          require_form_signals (false), ip_headers ({cf-connecting-ip}),
--                                          xff_trusted_hops (0), signed_in_ip_factor (4)
--                   app.rate_limits        tunable limits per (action, bucket, window_secs) — seeded, kept on re-run
--                   app.rate_hits          counters per (action, hashed key, window): sha256(salt | IP), never the IP;
--                                          src = which header gave the address (cf / xri / xff / none), never its value
--   1. helpers      app.antispam_client_ip()  (ip, net48, src): ONLY the headers listed in ip_headers, in that order,
--                                             each validated on its own (a malformed one falls through to the next);
--                                             default cf-connecting-ip alone (set by Cloudflare in front of Supabase,
--                                             overwrites a client value); x-real-ip / x-forwarded-for are opt-in
--                                             (client-forgeable or shared edge address); IPv6 → /64 + its /48
--                   app.antispam_gate(action, signals, org)  form signals, then the sliding-window limits of every
--                                             bucket of the caller: visitor → ip (+ ip48 for IPv6) or unknown;
--                                             signed-in non-member → the same IP buckets × signed_in_ip_factor + user;
--                                             member / client of the target org → not limited.
--                                             one generic refusal for every check: MRS_RATE_LIMITED 'try_later'
--                   app.antispam_purge()      old windows; called by app.client_errors_purge (existing daily cron
--                                             job marsa_client_errors_purge) — no new job
--                   app.antispam_stats()      SQL Editor monitoring (counts only, no key, no IP) + warnings
--   2. re-created   (bodies copied from the latest migration that defines each, changed minimally, marked "AS")
--                   public.submit_service_request (20261102000300)  gate 'request'; payload.antispam is stripped
--                   public.submit_contact_message (20261102000300)  gate 'contact'; before the idempotency hash
--                   public.public_track          (20261112000100)  gate 'track' (VOLATILE now: it writes counters);
--                                             a miss RETURNS {"not_found": true} instead of raising MRS_NOT_FOUND, so
--                                             failed guesses are counted too (a raise would roll the counter back)
--                   public.log_client_error      (20261102000300)  the visitor IP through app.antispam_client_ip()
--                                             (same trusted-header policy; was cf → x-real-ip → right-most XFF)
--                   app.client_errors_purge      (20261102000300)  + app.antispam_purge()
--   3. privileges   app objects: no API role; re-created functions re-asserted identically (signatures unchanged)
-- Form signals travel INSIDE the payload — payload.antispam = {"hp": <decoy field>, "elapsedMs": <ms since render>}
-- (the p_hp / p_elapsed_ms of the brief) — so no signature changes: old cached pages (sw.js) and the existing calls
-- keep working, the front end may be deployed before or after this file, and the idempotency hash ignores them.
-- Absent signals are not checked (backward compatible) until require_form_signals is switched on.
-- Who is limited: every API request (request.headers set by PostgREST) except a signed-in member / client of the
-- target organization (accountable; per-phone guard unchanged). Direct database sessions (SQL Editor, cron, tests
-- without headers) are not limited. Only committed actions are counted: a refusal (any MRS_* error) rolls its own
-- counter back (Postgres has no autonomous transaction); public_track therefore answers a miss as a value.
-- The per-phone / per-org guards of 20261031000400 are unchanged.
-- Re-runnable (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING keeps the salt and tuned limits).
-- Re-pasting 20261102000300 or 20261112000100 after this file restores bodies without the gate: re-paste this file
-- right after.
-- Down-path (staging only): re-paste the five bodies above (pages then show a miss as an error again), then
-- DROP FUNCTION app.antispam_gate(text, jsonb, uuid), app.antispam_client_ip(), app.antispam_purge(),
-- app.antispam_stats(); DROP TABLE app.rate_hits, app.rate_limits, app.antispam_settings.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261112000100') THEN
    RAISE EXCEPTION 'ANTISPAM preflight: apply deploy_env first (schema_versions lacks 20261112000100 deploy_env)';
  END IF;
  IF to_regprocedure('public.submit_service_request(jsonb)') IS NULL
     OR to_regprocedure('public.submit_contact_message(jsonb)') IS NULL
     OR to_regprocedure('public.public_track(text, text)') IS NULL
     OR to_regprocedure('public.log_client_error(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'ANTISPAM preflight: a public RPC is missing (submit_service_request / submit_contact_message / public_track / log_client_error)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261113000100', 'public_antispam')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. tables (schema app; only SECURITY DEFINER functions (owner) read / write them)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.antispam_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),                       -- exactly one row
  salt                 text NOT NULL DEFAULT app.new_token() CHECK (salt ~ '^[0-9a-f]{64}$'), -- per install, never returned
  min_fill_ms          int NOT NULL DEFAULT 2500 CHECK (min_fill_ms BETWEEN 0 AND 60000),
  require_form_signals boolean NOT NULL DEFAULT false,                                     -- true: a visitor form without
                                                                                           -- payload.antispam is refused
  -- which request headers may carry the visitor address, tried in this order (each validated on its own).
  -- cf-connecting-ip is written by Cloudflare (in front of *.supabase.co) and replaces any client value;
  -- x-real-ip / x-forwarded-for can be forged by the client or hold a shared edge address: opt-in only.
  ip_headers           text[] NOT NULL DEFAULT ARRAY['cf-connecting-ip']::text[]
                       CHECK (cardinality(ip_headers) BETWEEN 1 AND 3
                              AND ip_headers <@ ARRAY['cf-connecting-ip','x-real-ip','x-forwarded-for']::text[]),
  -- x-forwarded-for: how many right-most hops were appended by trusted proxies (0 = the right-most hop is the client)
  xff_trusted_hops     int NOT NULL DEFAULT 0 CHECK (xff_trusted_hops BETWEEN 0 AND 5),
  -- a signed-in user who is not a member / client of the target org gets the IP limits × this factor (+ bucket user)
  signed_in_ip_factor  int NOT NULL DEFAULT 4 CHECK (signed_in_ip_factor BETWEEN 1 AND 100),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.antispam_settings IS 'Public anti-spam settings of THIS database (one row): the IP-hash salt (never returned by any function), the minimum form fill time, whether form signals are required, the trusted IP headers, and the signed-in IP factor. Tuned from the SQL Editor (docs/online/ANTISPAM_AR.md).';
-- re-run keeps the salt and the tuned values
INSERT INTO app.antispam_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE app.antispam_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.antispam_settings FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app.rate_limits (
  action      text NOT NULL CHECK (action IN ('request','contact','track')),
  -- ip: one address (IPv4 host / IPv6 /64); ip48: the IPv6 /48 around it; user: one signed-in account;
  -- unknown: ONE shared bucket for the whole site (every API request without a usable address)
  bucket      text NOT NULL CHECK (bucket IN ('ip','ip48','user','unknown')),
  window_secs int  NOT NULL CHECK (window_secs BETWEEN 60 AND 604800),
  max_hits    int  NOT NULL CHECK (max_hits BETWEEN 0 AND 100000),       -- 0 closes the action for that bucket
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, bucket, window_secs)
);
COMMENT ON TABLE app.rate_limits IS 'Limits of the public entry points: at most max_hits committed actions per key of a bucket (ip, ip48, user; unknown = one key for the whole site) in a sliding window of window_secs. Tune with UPDATE from the SQL Editor; re-running the migration keeps tuned rows.';
INSERT INTO app.rate_limits (action, bucket, window_secs, max_hits) VALUES
  ('request', 'ip',      600,   5), ('request', 'ip',      86400,  20),
  ('request', 'ip48',    600,  15), ('request', 'ip48',    86400,  60),
  ('request', 'user',    600,  20), ('request', 'user',    86400, 100),
  ('request', 'unknown', 600,  15), ('request', 'unknown', 86400,  60),
  ('contact', 'ip',      600,   5), ('contact', 'ip',      86400,  20),
  ('contact', 'ip48',    600,  15), ('contact', 'ip48',    86400,  60),
  ('contact', 'user',    600,  20), ('contact', 'user',    86400, 100),
  ('contact', 'unknown', 600,  15), ('contact', 'unknown', 86400,  60),
  ('track',   'ip',      600,  30),
  ('track',   'ip48',    600,  90),
  ('track',   'user',    600, 120),
  ('track',   'unknown', 600,  60)
ON CONFLICT (action, bucket, window_secs) DO NOTHING;
ALTER TABLE app.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.rate_limits FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app.rate_hits (
  action       text NOT NULL CHECK (action IN ('request','contact','track')),
  ip_key       text NOT NULL CHECK (ip_key ~ '^[0-9a-f]{64}$'),        -- sha256(salt | IP, /48, u:<uid> or 'unknown')
  bucket       text NOT NULL CHECK (bucket IN ('ip','ip48','user','unknown')),
  window_secs  int  NOT NULL CHECK (window_secs BETWEEN 60 AND 604800),
  window_start timestamptz NOT NULL,
  hits         int  NOT NULL DEFAULT 0 CHECK (hits >= 0),
  src          text NOT NULL DEFAULT 'none' CHECK (src IN ('cf','xri','xff','none')),   -- last header used (name only)
  PRIMARY KEY (action, ip_key, window_secs, window_start)
);
COMMENT ON TABLE app.rate_hits IS 'Counters of committed public actions per hashed key and fixed window (the gate weighs the previous window for a sliding estimate). No raw IP, no personal data; src names the header that gave the address, never its value. Purged daily by app.antispam_purge() (via app.client_errors_purge).';
CREATE INDEX IF NOT EXISTS rate_hits_window_idx ON app.rate_hits (window_start);
ALTER TABLE app.rate_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.rate_hits FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. helpers
-- ---------------------------------------------------------------------
-- The visitor's address from the trusted headers only (app.antispam_settings.ip_headers, in order), normalised:
--   ip    IPv4 host; IPv4-mapped IPv6 → IPv4; IPv6 → its /64 (one subscriber line)
--   net48 IPv6 only: the /48 around it (one site / VPS allocation: rotating /64s inside it shares one budget)
--   src   'cf' | 'xri' | 'xff' — the header that gave it; 'none' when there are no request headers or no usable
--         address (every header is validated on its own: a malformed one falls through to the next listed one)
CREATE OR REPLACE FUNCTION app.antispam_client_ip(OUT ip text, OUT net48 text, OUT src text)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_h    jsonb;
  v_hdrs text[];
  v_hops int;
  v_name text;
  v_xff  text[];
  v     text;
  v_ip  inet;
BEGIN
  src := 'none';
  BEGIN
    v_h := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN RETURN;
  END;
  IF v_h IS NULL OR jsonb_typeof(v_h) <> 'object' THEN RETURN; END IF;
  SELECT s.ip_headers, s.xff_trusted_hops INTO v_hdrs, v_hops FROM app.antispam_settings s WHERE s.id;
  FOREACH v_name IN ARRAY coalesce(v_hdrs, ARRAY['cf-connecting-ip']::text[]) LOOP
    IF v_name = 'x-forwarded-for' THEN
      -- the hop just left of the trusted proxies (the left-most hops are written by the client)
      v_xff := string_to_array(v_h ->> 'x-forwarded-for', ',');
      v := btrim(v_xff[coalesce(array_length(v_xff, 1), 0) - coalesce(v_hops, 0)]);
    ELSE
      v := btrim(v_h ->> v_name);
    END IF;
    v_ip := NULL;
    IF v ~ '^[0-9A-Fa-f:.]{2,45}$' THEN
      BEGIN
        v_ip := v::inet;
      EXCEPTION WHEN others THEN v_ip := NULL;
      END;
    END IF;
    CONTINUE WHEN v_ip IS NULL;
    src := CASE v_name WHEN 'cf-connecting-ip' THEN 'cf' WHEN 'x-real-ip' THEN 'xri' ELSE 'xff' END;
    IF family(v_ip) = 4 THEN
      ip := host(v_ip);
    ELSIF v_ip << '::ffff:0:0/96'::inet THEN
      ip := regexp_replace(host(v_ip), '^.*:', '');                                         -- ::ffff:a.b.c.d
    ELSE
      ip := host(network(set_masklen(v_ip, 64))) || '/64';
      net48 := host(network(set_masklen(v_ip, 48))) || '/48';
    END IF;
    RETURN;
  END LOOP;
END $$;

-- The gate of every public entry point. p_signals = payload.antispam ({hp, elapsedMs}) or NULL; p_org = the target
-- organization (NULL for tracking).
--   1. form signals (everyone, when sent): a filled decoy field, or a fill time under min_fill_ms → refused;
--      require_form_signals: a visitor API request without them → refused
--   2. limits (API requests only; a signed-in member / client of p_org is accountable and not limited):
--        visitor               ip (+ ip48 for IPv6), or the shared unknown bucket
--        signed-in non-member  the same IP buckets with max_hits × signed_in_ip_factor, + user (its own account)
--      sliding window = this window's hits + the previous window's hits weighted by the part of it still inside the
--      window; the keys are counted (+1 per window) only when every window of every bucket is below its limit.
--      The counters commit with the action (a later error rolls them back).
-- Every refusal is the same: MRS_RATE_LIMITED 'try_later' — the caller never learns which check failed.
CREATE OR REPLACE FUNCTION app.antispam_gate(p_action text, p_signals jsonb DEFAULT NULL, p_org uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_set     app.antispam_settings;
  v_http    boolean := nullif(current_setting('request.headers', true), '') IS NOT NULL;
  v_uid     uuid := auth.uid();
  v_addr    record;
  v_buckets text[];
  v_vals    text[];
  v_factors int[];
  v_keys    text[] := '{}';
  v_k       text;
  v_hp      jsonb;
  v_ms      jsonb;
  v_bad     boolean := false;
  v_now     timestamptz := clock_timestamp();
  i         int;
  l         record;
  v_start   timestamptz;
  v_cur     int;
  v_prev    int;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('request','contact','track') THEN PERFORM app.fail('MRS_INVALID', 'action'); END IF;
  SELECT * INTO v_set FROM app.antispam_settings s WHERE s.id;
  IF v_set.id IS NULL THEN                                   -- row removed from the SQL Editor: a new salt
    INSERT INTO app.antispam_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_set FROM app.antispam_settings s WHERE s.id;
  END IF;

  -- 1. form signals
  IF p_signals IS NOT NULL AND jsonb_typeof(p_signals) = 'object' THEN
    v_hp := p_signals -> 'hp';
    v_ms := p_signals -> 'elapsedMs';
    IF v_hp IS NOT NULL AND jsonb_typeof(v_hp) <> 'null'
       AND (jsonb_typeof(v_hp) <> 'string' OR btrim(v_hp #>> '{}') <> '') THEN
      v_bad := true;                                         -- the decoy field holds something
    END IF;
    IF v_ms IS NOT NULL AND jsonb_typeof(v_ms) <> 'null'
       AND (jsonb_typeof(v_ms) <> 'number' OR (v_ms #>> '{}')::numeric < v_set.min_fill_ms) THEN
      v_bad := true;                                         -- filled faster than a person can, or not a number
    END IF;
  ELSIF p_signals IS NOT NULL AND jsonb_typeof(p_signals) <> 'null' THEN
    v_bad := true;                                           -- antispam present but not an object
  ELSIF v_set.require_form_signals AND v_http AND v_uid IS NULL AND p_action IN ('request','contact') THEN
    v_bad := true;                                           -- signals required and missing
  END IF;
  IF v_bad THEN PERFORM app.fail('MRS_RATE_LIMITED', 'try_later'); END IF;

  -- 2. limits: API requests only
  IF NOT v_http THEN RETURN; END IF;
  -- a member / client of the target organization is accountable (staff entering a request, a client's own portal)
  IF v_uid IS NOT NULL AND p_org IS NOT NULL
     AND (app.is_member(p_org)
          OR EXISTS (SELECT 1 FROM app.my_client_ids() x JOIN public.clients c ON c.id = x WHERE c.org_id = p_org)) THEN
    RETURN;
  END IF;
  SELECT * INTO v_addr FROM app.antispam_client_ip();
  IF v_addr.ip IS NULL THEN
    v_buckets := ARRAY['unknown']; v_vals := ARRAY['unknown'];
  ELSIF v_addr.net48 IS NULL THEN
    v_buckets := ARRAY['ip'];      v_vals := ARRAY[v_addr.ip];
  ELSE
    v_buckets := ARRAY['ip', 'ip48']; v_vals := ARRAY[v_addr.ip, v_addr.net48];
  END IF;
  v_factors := array_fill(CASE WHEN v_uid IS NULL THEN 1 ELSE v_set.signed_in_ip_factor END, ARRAY[cardinality(v_buckets)]);
  IF v_uid IS NOT NULL THEN
    v_buckets := v_buckets || 'user'::text; v_vals := v_vals || ('u:' || v_uid::text); v_factors := v_factors || 1;
  END IF;
  FOR i IN 1 .. cardinality(v_buckets) LOOP
    v_keys := v_keys || app.hash_token(v_set.salt || '|' || v_vals[i]);
  END LOOP;
  -- one key at a time, always in the same (sorted) order: concurrent requests of the same key cannot both slip
  -- under the limit, and two requests sharing several keys cannot deadlock
  FOR v_k IN SELECT k FROM unnest(v_keys) k ORDER BY k LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('marsa_antispam|' || p_action || '|' || v_k, 0));
  END LOOP;

  FOR i IN 1 .. cardinality(v_buckets) LOOP
    FOR l IN SELECT r.window_secs, r.max_hits FROM app.rate_limits r
              WHERE r.action = p_action AND r.bucket = v_buckets[i] ORDER BY r.window_secs LOOP
      v_start := to_timestamp(floor(extract(epoch FROM v_now) / l.window_secs) * l.window_secs);
      SELECT h.hits INTO v_cur FROM app.rate_hits h
       WHERE h.action = p_action AND h.ip_key = v_keys[i] AND h.window_secs = l.window_secs AND h.window_start = v_start;
      SELECT h.hits INTO v_prev FROM app.rate_hits h
       WHERE h.action = p_action AND h.ip_key = v_keys[i] AND h.window_secs = l.window_secs
         AND h.window_start = v_start - make_interval(secs => l.window_secs);
      IF coalesce(v_cur, 0) + coalesce(v_prev, 0) * (1 - extract(epoch FROM v_now - v_start) / l.window_secs)
         >= l.max_hits::numeric * v_factors[i] THEN
        PERFORM app.fail('MRS_RATE_LIMITED', 'try_later');
      END IF;
    END LOOP;
  END LOOP;

  FOR i IN 1 .. cardinality(v_buckets) LOOP
    INSERT INTO app.rate_hits AS h (action, ip_key, bucket, window_secs, window_start, hits, src)
    SELECT p_action, v_keys[i], v_buckets[i], r.window_secs,
           to_timestamp(floor(extract(epoch FROM v_now) / r.window_secs) * r.window_secs), 1, v_addr.src
      FROM app.rate_limits r WHERE r.action = p_action AND r.bucket = v_buckets[i]
    ON CONFLICT (action, ip_key, window_secs, window_start) DO UPDATE SET hits = h.hits + 1, src = EXCLUDED.src;
  END LOOP;
END $$;

-- windows that no longer weigh in (older than two windows)
CREATE OR REPLACE FUNCTION app.antispam_purge() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM app.rate_hits h
              WHERE h.window_start < now() - make_interval(secs => 2 * h.window_secs) RETURNING 1)
  SELECT count(*)::int FROM d
$$;

-- SQL Editor monitoring (no API role): last 24 hours, counts only — never a key or an IP.
-- SELECT app.antispam_stats();
CREATE OR REPLACE FUNCTION app.antispam_stats() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT r.action, r.bucket, min(r.window_secs) AS min_secs FROM app.rate_limits r GROUP BY r.action, r.bucket),
  -- committed actions of the address buckets (ip / unknown: each API action is counted in exactly one of them)
  -- by the header that gave the address, shortest window, last 24 hours
  src AS (SELECT h.action, h.src, sum(h.hits)::int AS n
            FROM app.rate_hits h JOIN m ON m.action = h.action AND m.bucket = h.bucket AND m.min_secs = h.window_secs
           WHERE h.bucket IN ('ip','unknown') AND h.window_start > now() - interval '24 hours'
           GROUP BY h.action, h.src),
  share AS (SELECT s.action, sum(s.n) AS total, coalesce(sum(s.n) FILTER (WHERE s.src = 'none'), 0) AS none
              FROM src s GROUP BY s.action)
  SELECT jsonb_build_object(
    'since', now() - interval '24 hours',
    'settings', (SELECT jsonb_build_object('min_fill_ms', s.min_fill_ms, 'require_form_signals', s.require_form_signals,
                                           'ip_headers', to_jsonb(s.ip_headers), 'xff_trusted_hops', s.xff_trusted_hops,
                                           'signed_in_ip_factor', s.signed_in_ip_factor, 'updated_at', s.updated_at)
                   FROM app.antispam_settings s WHERE s.id),
    'limits', (SELECT coalesce(jsonb_agg(jsonb_build_object('action', r.action, 'bucket', r.bucket,
                                                            'window_secs', r.window_secs, 'max_hits', r.max_hits)
                                         ORDER BY r.action, r.bucket, r.window_secs), '[]'::jsonb)
                 FROM app.rate_limits r),
    -- per action / bucket: distinct hashed keys, committed actions (shortest window), windows that reached their limit
    'buckets', (SELECT coalesce(jsonb_agg(jsonb_build_object('action', x.action, 'bucket', x.bucket, 'ips', x.ips,
                                                             'actions', x.actions, 'windows_at_limit', x.at_limit)
                                          ORDER BY x.action, x.bucket), '[]'::jsonb)
                  FROM (SELECT h.action, h.bucket, count(DISTINCT h.ip_key) AS ips,
                               coalesce(sum(h.hits) FILTER (WHERE h.window_secs = m.min_secs), 0) AS actions,
                               count(*) FILTER (WHERE h.hits >= r.max_hits) AS at_limit
                          FROM app.rate_hits h
                          JOIN app.rate_limits r ON r.action = h.action AND r.bucket = h.bucket AND r.window_secs = h.window_secs
                          JOIN m ON m.action = h.action AND m.bucket = h.bucket
                         WHERE h.window_start > now() - interval '24 hours'
                         GROUP BY h.action, h.bucket) x),
    -- which header gave the address (cf / xri / xff / none) — after deploying, "cf" must dominate
    'sources', (SELECT coalesce(jsonb_agg(jsonb_build_object('action', s.action, 'src', s.src, 'actions', s.n)
                                          ORDER BY s.action, s.src), '[]'::jsonb) FROM src s),
    'warnings', (SELECT coalesce(jsonb_agg(w.t ORDER BY w.t), '[]'::jsonb) FROM (
                   -- more than 10% of the actions (at least 20) had no usable address: the shared unknown bucket
                   -- is the whole site's budget — check ip_headers (docs/online/ANTISPAM_AR.md §3)
                   SELECT 'unknown_share_high:' || sh.action AS t FROM share sh WHERE sh.total >= 20 AND sh.none * 10 > sh.total
                   UNION ALL
                   -- a client-forgeable / shared header is trusted
                   SELECT 'spoofable_ip_header' FROM app.antispam_settings s
                    WHERE s.id AND s.ip_headers && ARRAY['x-real-ip','x-forwarded-for']::text[]) w),
    -- refusals the pages reported back through log_client_error (code MRS_RATE_LIMITED; no personal data)
    'refusals_reported', (SELECT count(*) FROM public.client_errors e
                           WHERE e.code = 'MRS_RATE_LIMITED' AND e.created_at > now() - interval '24 hours'))
$$;

-- ---------------------------------------------------------------------
-- 2. re-created functions (latest bodies, minimal changes marked "AS")
-- ---------------------------------------------------------------------
-- submit_service_request (20261102000300; signature unchanged; key in payload.idempotencyKey)
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
  v_signals jsonb := CASE WHEN jsonb_typeof(payload) = 'object' THEN payload -> 'antispam' END;     -- AS
BEGIN
  -- AS: the form signals are not request data (and never part of the idempotency hash)
  IF jsonb_typeof(payload) = 'object' THEN payload := payload - 'antispam'; END IF;
  -- replay BEFORE the open/active gate: a committed submission whose response was lost
  -- still replays after intake is closed (unknown slug → the same MRS_INTAKE_CLOSED)
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea');
  IF v_org.id IS NULL THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  v_key := app.idem_key_from(payload);
  v_replay := app.idem_begin('submit_service_request', v_key, payload, v_org.id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT v_org.is_active OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  PERFORM app.antispam_gate('request', v_signals, v_org.id);                                         -- AS

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

-- submit_contact_message (20261102000300; signature unchanged; key in payload.idempotencyKey).
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
  v_signals jsonb;                                                                                    -- AS
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  IF length(payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  v_signals := payload -> 'antispam';                                                                 -- AS
  payload := payload - 'antispam';                                                                    -- AS
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea');
  IF v_org.id IS NULL THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  v_key := app.idem_key_from(payload);
  v_replay := app.idem_begin('submit_contact_message', v_key, payload, v_org.id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT v_org.is_active OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  PERFORM app.antispam_gate('contact', v_signals, v_org.id);                                         -- AS

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

-- public_track (20261112000100): a suspended organization's requests / transactions are not trackable.
-- AS: VOLATILE (was STABLE) — the gate writes the per-IP counter of every lookup.
-- AS: a miss (bad format, unknown ref / token, suspended org) RETURNS {"not_found": true} — the same value for every
--     cause (no oracle) — instead of raising MRS_NOT_FOUND: a raise would roll the counter back, so failed guesses
--     were never counted. supa.js publicTrack maps it back to the MRS_NOT_FOUND error the pages already show.
--     A signed-in admin who still owes MFA keeps the MRS_MFA_REQUIRED answer of app.fail (20261109000100).
CREATE OR REPLACE FUNCTION public.public_track(p_ref text, p_token text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ref  text := upper(btrim(coalesce(p_ref, '')));
  v_tok  text := lower(btrim(coalesce(p_token, '')));
  v_hash text;
  v_req  public.service_requests;
  v_tx   public.transactions;
  v_res  jsonb;
  v_tl   jsonb;
BEGIN
  PERFORM app.antispam_gate('track', NULL);                                                          -- AS
  IF v_ref !~ '^[A-Z]{2,5}-[0-9]{4}-[0-9]{6,}$' OR v_tok !~ '^[0-9a-f]{64}$' THEN
    IF app.mfa_pending() THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;                             -- AS
    RETURN jsonb_build_object('not_found', true);                                                    -- AS
  END IF;
  v_hash := app.hash_token(v_tok);

  SELECT * INTO v_req FROM public.service_requests r WHERE r.ref = v_ref AND r.tracking_token_hash = v_hash LIMIT 1;
  IF v_req.id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.request_id = v_req.id;
  ELSE
    SELECT * INTO v_tx FROM public.transactions t WHERE t.ref = v_ref AND t.tracking_token_hash = v_hash LIMIT 1;
    IF v_tx.id IS NULL THEN
      IF app.mfa_pending() THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;                           -- AS
      RETURN jsonb_build_object('not_found', true);                                                  -- AS
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = coalesce(v_req.org_id, v_tx.org_id) AND o.is_active) THEN
    IF app.mfa_pending() THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;                             -- AS
    RETURN jsonb_build_object('not_found', true);                                                    -- AS
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

-- log_client_error (20261102000300; signature unchanged; anon + authenticated): the per-visitor key now uses the
-- same trusted-header policy as the gate (AS) — the rest of the body is unchanged.
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
BEGIN
  -- deliberately callable by visitors: no auth check. Only an oversized payload raises.
  IF p_payload IS NOT NULL AND length(p_payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RETURN jsonb_build_object('logged', false); END IF;

  -- who: signed-in user, else the visitor's IP, else the page's random visitor id (hashed, never stored raw).
  -- AS: the IP comes from app.antispam_client_ip() — only the trusted headers of app.antispam_settings.ip_headers
  -- (default cf-connecting-ip, set by the edge), each validated; IPv6 grouped by /64. A client-written
  -- x-real-ip / X-Forwarded-For no longer lets one visitor rotate past the per-visitor limit.
  IF v_uid IS NOT NULL THEN
    v_who := 'u:' || v_uid::text;
  ELSE
    BEGIN
      v_who := (SELECT a.ip FROM app.antispam_client_ip() a);                                            -- AS
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

-- client_errors_purge (20261102000300; daily cron job marsa_client_errors_purge — unchanged schedule and command).
-- AS: also drops the anti-spam windows that no longer weigh in; the result is still the client_errors count.
CREATE OR REPLACE FUNCTION app.client_errors_purge(p_days int DEFAULT 30) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.antispam_purge();                                                                       -- AS
  WITH d AS (DELETE FROM public.client_errors e WHERE e.created_at < now() - make_interval(days => greatest(p_days, 1)) RETURNING 1)
  SELECT count(*)::int FROM d
$$;

-- ---------------------------------------------------------------------
-- 3. privileges
-- ---------------------------------------------------------------------
-- app helpers: called by SECURITY DEFINER code (owner) / the SQL Editor only
REVOKE EXECUTE ON FUNCTION app.antispam_client_ip(), app.antispam_gate(text, jsonb, uuid), app.antispam_purge(),
  app.antispam_stats()
FROM PUBLIC, anon, authenticated, service_role;
-- as in 20261102000300 §6
REVOKE EXECUTE ON FUNCTION app.client_errors_purge(int) FROM PUBLIC, anon, authenticated;

-- re-created public functions (as in 20261102000300 §6 / 20261112000100 §5: visitors + signed-in users)
REVOKE EXECUTE ON FUNCTION public.submit_service_request(jsonb), public.submit_contact_message(jsonb),
  public.public_track(text, text), public.log_client_error(jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_service_request(jsonb), public.submit_contact_message(jsonb),
  public.public_track(text, text), public.log_client_error(jsonb)
TO anon, authenticated;
