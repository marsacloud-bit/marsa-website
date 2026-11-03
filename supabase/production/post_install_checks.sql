-- =====================================================================
-- Marsa — PRODUCTION post-install checks (supabase/production/README.md). ONE read-only query: paste into the SQL Editor
-- of the production project and Run, any time (after install, after every migration, before go-live). Writes nothing,
-- calls no network, needs migration 20261112000100_deploy_env.sql. Works with or without pg_cron / pg_net / vault.
-- Returns one JSON value "checks":
--   health_check, schema_version (+ the minimum this file needs), deploy_environment, public_tables_without_rls,
--   demo_org_present, seed_rows, platform_admins [{email (masked), totp_verified}], msg_channels_mock,
--   daftra_connections_mock, orgs_by_environment, extensions {pg_cron, pg_net, pg_trgm, supabase_vault}, cron_jobs,
--   blockers (empty = ready for real data)
-- cron_jobs lists jobid / jobname / schedule / active only: a job's command can hold a key, so it is never shown.
-- Blockers beyond the data checks: pg_cron_missing (enable it BEFORE the install: the migrations schedule their jobs only
-- when it exists), cron_job_missing:<name> (marsa_idem_purge / marsa_client_errors_purge / marsa_refresh_alerts absent or
-- inactive), env_body_reverted (an older migration re-pasted over health_check / public_track / platform_create_org
-- brought back a hard-coded 'staging': re-paste 20261112000100_deploy_env.sql).
-- =====================================================================
WITH
h AS (SELECT public.health_check() AS j),
rls AS (
  SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb) AS names
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity),
demo AS (
  SELECT EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.slug = 'blue-sea' OR o.id = '0b5e0000-0000-4000-8000-000000000001'::uuid
                     OR coalesce(o.settings ->> 'demo', '') = 'true') AS present),
-- supabase/seed.sql uses fixed ids 0b5e0000-0000-4000-8000-…
seed AS (
  SELECT (SELECT count(*) FROM public.organizations     WHERE id::text LIKE '0b5e0000-%')
       + (SELECT count(*) FROM public.branches          WHERE id::text LIKE '0b5e0000-%')
       + (SELECT count(*) FROM public.clients           WHERE id::text LIKE '0b5e0000-%')
       + (SELECT count(*) FROM public.transactions      WHERE id::text LIKE '0b5e0000-%')
       + (SELECT count(*) FROM public.containers        WHERE id::text LIKE '0b5e0000-%')
       + (SELECT count(*) FROM public.service_requests  WHERE id::text LIKE '0b5e0000-%') AS n),
adm AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'email', app.mask_email(u.email),
           'totp_verified', EXISTS (SELECT 1 FROM auth.mfa_factors f
                                     WHERE f.user_id = pa.user_id AND f.factor_type::text = 'totp' AND f.status::text = 'verified'))
           ORDER BY pa.created_at), '[]'::jsonb) AS list
    FROM public.platform_admins pa LEFT JOIN auth.users u ON u.id = pa.user_id),
ext AS (
  SELECT jsonb_build_object(
           'pg_cron',        (SELECT e.extversion FROM pg_extension e WHERE e.extname = 'pg_cron'),
           'pg_net',         (SELECT e.extversion FROM pg_extension e WHERE e.extname = 'pg_net'),
           'pg_trgm',        (SELECT e.extversion FROM pg_extension e WHERE e.extname = 'pg_trgm'),
           'supabase_vault', (SELECT e.extversion FROM pg_extension e WHERE e.extname = 'supabase_vault')) AS j),
-- cron.job exists only with pg_cron: read through query_to_xml (no parse error without it); hex keeps the JSON XML-safe
cron AS (
  SELECT CASE WHEN to_regclass('cron.job') IS NULL THEN NULL
              ELSE convert_from(decode(substring(query_to_xml(
                     'SELECT encode(convert_to(coalesce(jsonb_agg(jsonb_build_object(''jobid'', j.jobid, ''jobname'', j.jobname, '
                     || '''schedule'', j.schedule, ''active'', j.active) ORDER BY j.jobid), ''[]''::jsonb)::text, ''UTF8''), ''hex'') x '
                     || 'FROM cron.job j', false, true, '')::text FROM '<x>([0-9a-f]*)</x>'), 'hex'), 'UTF8')::jsonb
         END AS list),
-- the three functions 20261112000100 re-created must still read app.deploy_environment()
envfn AS (
  SELECT count(*) FILTER (WHERE p.prosrc LIKE '%app.deploy_environment()%') AS ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('health_check', 'public_track', 'platform_create_org')),
c AS (
  SELECT (SELECT j FROM h) AS health,
         (SELECT j ->> 'environment' FROM h) AS env,
         (SELECT names FROM rls) AS no_rls,
         (SELECT present FROM demo) AS demo,
         (SELECT n FROM seed) AS seed,
         (SELECT list FROM adm) AS admins,
         (SELECT count(*) FROM public.msg_channels m WHERE m.mode = 'mock') AS msg_mock,
         (SELECT count(*) FROM public.daftra_connections d WHERE d.mode = 'mock') AS daftra_mock,
         (SELECT coalesce(jsonb_object_agg(x.environment, x.n), '{}'::jsonb)
            FROM (SELECT o.environment, count(*) n FROM public.organizations o GROUP BY 1) x) AS orgs,
         (SELECT j FROM ext) AS ext,
         (SELECT list FROM cron) AS cron,
         (SELECT ok FROM envfn) AS env_fns)
SELECT jsonb_build_object(
         'health_check', c.health,
         'schema_version', c.health ->> 'schema_version',
         'min_schema_version', '20261112000100',
         'deploy_environment', c.env,
         'public_tables_without_rls', jsonb_array_length(c.no_rls),
         'public_tables_without_rls_names', c.no_rls,
         'demo_org_present', c.demo,
         'seed_rows', c.seed,
         'platform_admins', c.admins,
         'platform_admins_count', jsonb_array_length(c.admins),
         'msg_channels_mock', c.msg_mock,
         'daftra_connections_mock', c.daftra_mock,
         'orgs_by_environment', c.orgs,
         'extensions', c.ext,
         'cron_jobs', c.cron,
         'blockers', to_jsonb(array_remove(ARRAY[
           CASE WHEN c.env IS DISTINCT FROM 'production' THEN 'deploy_environment_not_production' END,
           CASE WHEN coalesce(c.health ->> 'schema_version', '') < '20261112000100' THEN 'schema_version_too_old' END,
           CASE WHEN jsonb_array_length(c.no_rls) > 0 THEN 'public_tables_without_rls' END,
           CASE WHEN c.demo THEN 'demo_org_present' END,
           CASE WHEN c.seed > 0 THEN 'seed_rows_present' END,
           CASE WHEN jsonb_array_length(c.admins) = 0 THEN 'no_platform_admin' END,
           CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(c.admins) a WHERE NOT (a ->> 'totp_verified')::boolean)
                THEN 'platform_admin_without_totp' END,
           CASE WHEN coalesce((c.orgs ->> 'staging')::int, 0) > 0 THEN 'staging_orgs_present' END,
           CASE WHEN c.ext ->> 'pg_cron' IS NULL THEN 'pg_cron_missing' END
         ]::text[], NULL)
         || ARRAY(SELECT 'cron_job_missing:' || x.name
                    FROM unnest(ARRAY['marsa_idem_purge', 'marsa_client_errors_purge', 'marsa_refresh_alerts']) WITH ORDINALITY x(name, i)
                   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(c.cron, '[]'::jsonb)) j
                                      WHERE j ->> 'jobname' = x.name AND (j ->> 'active')::boolean)
                   ORDER BY x.i)
         || array_remove(ARRAY[
           CASE WHEN c.env_fns < 3 THEN 'env_body_reverted' END
         ]::text[], NULL))
       ) AS checks
  FROM c;
