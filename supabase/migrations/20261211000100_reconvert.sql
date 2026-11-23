-- =====================================================================
-- 20261211000100_reconvert — wipe an ALREADY converted (production) organisation's data again and restart its numbering
-- with a new transaction prefix and slug (owner request, 23 Nov 2026). Owner runbook: docs/online/CONVERT_IN_PLACE_AR.md
-- (part «إعادة التحويل») and the plain plan docs/owner/convert-plan-simple.md.
-- Builds on convert_in_place (20261115000100) and every later phase up to ai_keys (20261209000100). Applying this file
-- deletes NO business data: it adds the functions below, makes the PAY- / CUS- numbering per organisation and widens the
-- mail transaction-reference check. The re-conversion itself runs only when the owner calls, from the SQL Editor
-- (postgres, no JWT claims), after a backup:
--   step 1 (read-only):  SELECT public.reconvert_org_preview('<org uuid>', '<new-slug>', '<NEW PREFIX>');
--   step 2 (the wipe):   SELECT public.reconvert_org('<org uuid>', '<new-slug>', '<NEW PREFIX>',
--                                                   'WIPE-ALL-DATA-<current-slug>-TO-<new-slug>-<NEW PREFIX>', '<الاسم العربي>|NULL', '<English name>|NULL');
--   The confirm phrase names the org being wiped (its CURRENT slug) as well as the new slug / prefix, so a wrong org uuid
--   pasted in step 2 is refused (confirm) unless its own slug was typed too.
--   P. preflight (convert_in_place + ai_keys applied) + schema_versions row
--   1. app.org_conversions: + run_no (1 = the first conversion) + kind ('convert' | 'reconvert'); primary key
--      (org_id, run_no). Still append-only. public.convert_org_to_production is unchanged and still refuses an org that
--      has a row here (already_production): a second run is possible ONLY through public.reconvert_org.
--   2. per-org PAY- / CUS- numbering: org_counters scopes + 'payment' / 'custody' (year 0 = no yearly reset);
--      app.next_org_seq(org, scope); BEFORE INSERT trigger trg_org_seq on client_disbursements / client_custody_entries
--      sets seq + ref from the org's counter (the global sequences stay as column defaults only); the unique keys
--      become (org_id, ref). The counters start at each org's current highest number, so no existing reference changes
--      and no reference is reused inside an org. Deleting an org's org_counters rows (conversion / re-conversion) restarts
--      PAY-000001 / CUS-000001 for that org only.
--   3. mail: app.msg_tx_ref_ok(text) — the transaction reference shape of ANY org prefix (2–5 capital letters, then
--      -YYYY-NNNNNN), not REQ- / MSG- / IMP-; public.review_msg_extraction (20261107000100 body) re-created with it in
--      place of the hard-coded '^MRS-…' (the Edge Function extractors ai-mock.js / llm-provider.js changed alike).
--   4. helpers   app.reconvert_reserved_prefixes(), app.reconvert_used_prefixes(org), app.reconvert_input_errors(…),
--                app.reconvert_check(org)  (app.convert_check minus already_production / other_staging_orgs /
--                daftra_not_cleared, plus not_production and never_converted: an org with no app.org_conversions row was
--                never converted and cannot be wiped by this path), app.reconvert_wipe(org) (the original conversion's delete:
--                app.convert_delete_tables / app.convert_delete_guards / memberships / org_counters / org_usage_counters,
--                the same lists, so every table added by 20261116000100 … 20261209000100 is covered), app.reconvert_ready(org)
--                (+ todo: storage_objects_left while the org's '<org>/' folders still hold files)
--   5. public.reconvert_org_preview(org, slug, prefix)  read-only: rows per table that WOULD be deleted, what is kept
--                (counts per kept table, branches, channels, accounting link, AI settings), memberships kept / removed,
--                counters reset, storage objects, Daftra documents (a warning: a new prefix cannot collide with them),
--                accounts left without access, input errors, blockers, the exact confirm phrase. SQL Editor only.
--   6. public.reconvert_org(org, slug, prefix, confirm, name_ar, name_en)  the wipe + new slug / prefix / optional names,
--                recorded in app.org_conversions (kind 'reconvert'). SQL Editor only.
--   7. privileges: every function of 4–6: no API role (not even service_role).
-- MFA (owner decision 15 Nov 2026, 20261129000100): no check here asks for a verified TOTP factor; app.reconvert_ready
-- (the readiness list returned after the run) has no TOTP item.
-- Kept by the re-conversion (exactly like the first conversion): the org row (new slug / prefix / names; settings and
-- environment unchanged), branches, the platform admins' admin membership, mail channels (MOCK channels switched off),
-- mail settings / templates / instructions / auto-reply policies, the accounting link (daftra_connections /
-- daftra_item_links), document requirements, service items, stage sets, storage-gate ports, the subscription,
-- AI settings / provider keys, and the append-only logs (audit_log, report_exports, ai_usage, alert runs, client errors).
-- Re-runnable file (IF NOT EXISTS / CREATE OR REPLACE / guarded ALTERs). No BEGIN/COMMIT (the SQL editor wraps the run).
-- Down-path (before any re-conversion only): DROP FUNCTION public.reconvert_org(uuid, text, text, text, text, text),
-- public.reconvert_org_preview(uuid, text, text) and the app.reconvert_* helpers; re-paste 20261107000100 §review_msg_extraction;
-- DROP TRIGGER trg_org_seq ON public.client_disbursements / public.client_custody_entries; DROP FUNCTION app.tg_org_seq(),
-- app.next_org_seq(uuid, text), app.msg_tx_ref_ok(text); restore UNIQUE (ref) on both tables (only while no two orgs share a
-- reference); DELETE FROM public.org_counters WHERE scope IN ('payment','custody') and restore the 4-scope CHECK; restore the
-- org_conversions primary key (org_id) (only while one row per org); DELETE FROM public.schema_versions WHERE version = '20261211000100'.
-- After a re-conversion the only way back is a restore of the backup taken before it.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261209000100') THEN
    RAISE EXCEPTION 'RECONVERT preflight: apply ai_keys first (schema_versions lacks 20261209000100)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261115000100')
     OR to_regclass('app.org_conversions') IS NULL OR to_regprocedure('app.convert_check(uuid)') IS NULL
     OR to_regprocedure('app.convert_delete_tables()') IS NULL OR to_regprocedure('app.convert_delete_guards()') IS NULL
     OR to_regprocedure('app.convert_keep_tables()') IS NULL THEN
    RAISE EXCEPTION 'RECONVERT preflight: convert_in_place missing (apply 20261115000100_convert_in_place.sql)';
  END IF;
  IF to_regclass('public.client_disbursements') IS NULL OR to_regclass('public.client_custody_entries') IS NULL
     OR to_regprocedure('public.review_msg_extraction(uuid, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'RECONVERT preflight: legacy_pay / inbox objects missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261211000100', 'reconvert')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. app.org_conversions: one row per run (run_no 1 = the first conversion)
-- ---------------------------------------------------------------------
ALTER TABLE app.org_conversions ADD COLUMN IF NOT EXISTS run_no int NOT NULL DEFAULT 1;
ALTER TABLE app.org_conversions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'convert';
DO $pk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'app.org_conversions'::regclass AND c.conname = 'org_conversions_kind_chk') THEN
    ALTER TABLE app.org_conversions ADD CONSTRAINT org_conversions_kind_chk CHECK (kind IN ('convert', 'reconvert'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'app.org_conversions'::regclass AND c.conname = 'org_conversions_run_chk') THEN
    ALTER TABLE app.org_conversions ADD CONSTRAINT org_conversions_run_chk CHECK (run_no >= 1 AND (run_no = 1) = (kind = 'convert'));
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'app.org_conversions'::regclass AND c.contype = 'p') IS DISTINCT FROM 'PRIMARY KEY (org_id, run_no)' THEN
    ALTER TABLE app.org_conversions DROP CONSTRAINT IF EXISTS org_conversions_pkey;
    ALTER TABLE app.org_conversions ADD CONSTRAINT org_conversions_pkey PRIMARY KEY (org_id, run_no);
  END IF;
END $pk$;
COMMENT ON TABLE app.org_conversions IS 'In-place conversions of an org: run_no 1 = staging → production (public.convert_org_to_production, kind convert); run_no 2… = re-conversions (public.reconvert_org, kind reconvert: data wiped again, new slug / prefix). Append-only record: from / to slug, who, when, rows deleted per table. Read by supabase/production/post_install_checks.sql.';

-- ---------------------------------------------------------------------
-- 2. per-org PAY- / CUS- numbering
-- ---------------------------------------------------------------------
DO $scope$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.org_counters'::regclass AND c.conname = 'org_counters_scope_check') NOT LIKE '%custody%' THEN
    ALTER TABLE public.org_counters DROP CONSTRAINT org_counters_scope_check;
    ALTER TABLE public.org_counters ADD CONSTRAINT org_counters_scope_check
      CHECK (scope IN ('transaction', 'request', 'message', 'import', 'payment', 'custody'));
  END IF;
END $scope$;

-- the next number of an org's non-yearly counter (year 0); the row lock serialises concurrent inserts of one org
CREATE OR REPLACE FUNCTION app.next_org_seq(p_org uuid, p_scope text) RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_n bigint;
BEGIN
  IF p_org IS NULL OR p_scope NOT IN ('payment', 'custody') THEN PERFORM app.fail('MRS_INVALID', 'counter_scope'); END IF;
  INSERT INTO public.org_counters AS c (org_id, scope, year, last_value)
  VALUES (p_org, p_scope, 0, 1)
  ON CONFLICT (org_id, scope, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN v_n;
END $$;

-- TG_ARGV[0] = counter scope, TG_ARGV[1] = reference prefix. Always overrides seq / ref (the RPCs' nextval value is ignored)
CREATE OR REPLACE FUNCTION app.tg_org_seq() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.seq := app.next_org_seq(NEW.org_id, TG_ARGV[0]);
  NEW.ref := TG_ARGV[1] || '-' || lpad(NEW.seq::text, 6, '0');
  RETURN NEW;
END $$;

-- start each org's counter at its current highest number (re-run: never lowers a counter)
INSERT INTO public.org_counters AS c (org_id, scope, year, last_value)
SELECT d.org_id, 'payment', 0, max(d.seq) FROM public.client_disbursements d GROUP BY d.org_id
ON CONFLICT (org_id, scope, year) DO UPDATE SET last_value = greatest(c.last_value, EXCLUDED.last_value);
INSERT INTO public.org_counters AS c (org_id, scope, year, last_value)
SELECT e.org_id, 'custody', 0, max(e.seq) FROM public.client_custody_entries e GROUP BY e.org_id
ON CONFLICT (org_id, scope, year) DO UPDATE SET last_value = greatest(c.last_value, EXCLUDED.last_value);

DROP TRIGGER IF EXISTS trg_org_seq ON public.client_disbursements;
CREATE TRIGGER trg_org_seq BEFORE INSERT ON public.client_disbursements
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_seq('payment', 'PAY');
DROP TRIGGER IF EXISTS trg_org_seq ON public.client_custody_entries;
CREATE TRIGGER trg_org_seq BEFORE INSERT ON public.client_custody_entries
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_seq('custody', 'CUS');

DO $uniq$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.client_disbursements'::regclass AND c.conname = 'client_disbursements_ref_uniq') IS DISTINCT FROM 'UNIQUE (org_id, ref)' THEN
    ALTER TABLE public.client_disbursements DROP CONSTRAINT IF EXISTS client_disbursements_ref_uniq;
    ALTER TABLE public.client_disbursements ADD CONSTRAINT client_disbursements_ref_uniq UNIQUE (org_id, ref);
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.client_custody_entries'::regclass AND c.conname = 'client_custody_entries_ref_uniq') IS DISTINCT FROM 'UNIQUE (org_id, ref)' THEN
    ALTER TABLE public.client_custody_entries DROP CONSTRAINT IF EXISTS client_custody_entries_ref_uniq;
    ALTER TABLE public.client_custody_entries ADD CONSTRAINT client_custody_entries_ref_uniq UNIQUE (org_id, ref);
  END IF;
END $uniq$;

-- ---------------------------------------------------------------------
-- 3. mail: the transaction reference of any org prefix
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.msg_tx_ref_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(p ~ '^[A-Z]{2,5}-[0-9]{4}-[0-9]{6}$' AND p !~ '^(REQ|MSG|IMP)-', false)
$$;

-- review_msg_extraction (20261107000100 body; only the tx_ref check changed: app.msg_tx_ref_ok)
CREATE OR REPLACE FUNCTION public.review_msg_extraction(p_id uuid, p_decision text, p_value text DEFAULT NULL, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.msg_extractions; t public.msg_threads; v_val text; v_note text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO e FROM public.msg_extractions x WHERE x.id = p_id;
  IF e.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'extraction'); END IF;
  t := app.msg_thread_for(e.thread_id, app.msg_triage_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('confirm','correct','reject') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.msg_note(p_note, p_decision = 'correct');
  IF p_decision = 'correct' THEN
    v_val := upper(regexp_replace(app.to_western(btrim(coalesce(p_value, ''))), '[[:space:]]+', '', 'g'));
    IF e.kind = 'container_no' THEN v_val := replace(v_val, '-', ''); END IF;
    IF v_val = '' OR char_length(v_val) > 200
       OR (e.kind = 'container_no' AND NOT app.msg_iso6346_ok(v_val))
       OR (e.kind = 'tx_ref' AND NOT app.msg_tx_ref_ok(v_val))                                          -- RECONVERT
       OR (e.kind = 'date' AND (v_val !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR app.pdate(jsonb_build_object('d', v_val), 'd') IS NULL))
       OR (e.kind IN ('bl_number','declaration_no','invoice_no','appointment_no') AND v_val !~ '^[A-Z0-9/-]{3,40}$') THEN
      PERFORM app.fail('MRS_INVALID', 'extraction');
    END IF;
  END IF;
  UPDATE public.msg_extractions x SET status = CASE p_decision WHEN 'confirm' THEN 'confirmed' WHEN 'correct' THEN 'corrected' ELSE 'rejected' END,
         corrected_value = CASE WHEN p_decision = 'correct' THEN v_val END, reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
   WHERE x.id = e.id RETURNING * INTO e;
  PERFORM app.msg_match(t.id);
  RETURN to_jsonb(e) || jsonb_build_object('thread', (SELECT app.msg_thread_json(x) FROM public.msg_threads x WHERE x.id = t.id));
END $$;

-- ---------------------------------------------------------------------
-- 4. re-conversion helpers
-- ---------------------------------------------------------------------
-- prefixes that would read as another kind of reference (request / message / import / payment / custody / import run /
-- Daftra markers / appointment / test data)
CREATE OR REPLACE FUNCTION app.reconvert_reserved_prefixes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['REQ', 'MSG', 'IMP', 'PAY', 'CUS', 'LIR', 'MRSC', 'MRSL', 'MRSO', 'MRSP', 'TAS', 'TEST', 'TST']::text[]
$$;

-- every transaction prefix this org has used: the current one + those recorded by earlier runs (a reused prefix would
-- restart at …-000001 and meet old documents in Daftra / e-mail with the same reference)
CREATE OR REPLACE FUNCTION app.reconvert_used_prefixes(p_org uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT x.p ORDER BY x.p) FILTER (WHERE x.p IS NOT NULL), ARRAY[]::text[]) FROM (
    SELECT o.ref_prefix p FROM public.organizations o WHERE o.id = p_org
    UNION ALL SELECT c.summary ->> 'from_ref_prefix' FROM app.org_conversions c WHERE c.org_id = p_org
    UNION ALL SELECT c.summary ->> 'ref_prefix' FROM app.org_conversions c WHERE c.org_id = p_org) x
$$;

-- input errors (empty = valid). A NULL name keeps the current one.
CREATE OR REPLACE FUNCTION app.reconvert_input_errors(p_org uuid, p_slug text, p_prefix text, p_name_ar text, p_name_en text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o        public.organizations;
  v_slug   text := lower(btrim(coalesce(p_slug, '')));
  v_prefix text := upper(btrim(coalesce(p_prefix, '')));
  v_out    text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org;
  IF o.id IS NULL THEN RETURN ARRAY['org_not_found']; END IF;
  IF v_slug !~ '^[a-z0-9-]{3,40}$' OR v_slug !~ '^[a-z0-9]' THEN
    v_out := v_out || 'slug'::text;
  ELSE
    o.slug := v_slug;
    IF app.is_demo_org(o) THEN v_out := v_out || 'slug_demo'::text; END IF;
    IF EXISTS (SELECT 1 FROM public.organizations x WHERE x.slug = v_slug AND x.id <> p_org) THEN v_out := v_out || 'slug_taken'::text; END IF;
  END IF;
  IF v_prefix !~ '^[A-Z]{2,5}$' THEN
    v_out := v_out || 'ref_prefix'::text;
  ELSIF v_prefix = ANY (app.reconvert_reserved_prefixes()) THEN
    v_out := v_out || 'ref_prefix_reserved'::text;
  ELSIF v_prefix = ANY (app.reconvert_used_prefixes(p_org)) THEN
    v_out := v_out || 'ref_prefix_used'::text;
  END IF;
  IF p_name_ar IS NOT NULL AND (char_length(btrim(p_name_ar)) NOT BETWEEN 2 AND 160 OR p_name_ar ~ 'تجريبي|اختبار') THEN
    v_out := v_out || 'name_ar'::text;
  END IF;
  IF p_name_en IS NOT NULL AND (char_length(btrim(p_name_en)) > 160 OR p_name_en ~* '\m(staging|demo|test)\M') THEN
    v_out := v_out || 'name_en'::text;
  END IF;
  RETURN v_out;
END $$;

-- refusals shared by the preview and the run (empty = the run may start). The first conversion's checks are reused
-- (owner admin membership, every org-scoped table classified, only the listed delete guards); dropped: already_production
-- (this IS the path for a converted org), other_staging_orgs (the deploy switch is not called again) and
-- daftra_not_cleared (a NEW prefix cannot meet the old Daftra references: reported as a warning by the preview).
-- Added: not_production, and never_converted (no app.org_conversions row: an org created directly in production — another
-- real office — was never converted, so this path never wipes it).
CREATE OR REPLACE FUNCTION app.reconvert_check(p_org uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o     public.organizations;
  v_out text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org;
  IF o.id IS NULL THEN RETURN ARRAY['org_not_found']; END IF;
  IF o.environment <> 'production' OR app.deploy_environment() <> 'production' THEN
    v_out := v_out || 'not_production'::text;          -- a staging org uses public.convert_org_to_production
  END IF;
  SELECT v_out || coalesce(array_agg(x ORDER BY i), ARRAY[]::text[]) INTO v_out
    FROM unnest(app.convert_check(p_org)) WITH ORDINALITY u(x, i)
   WHERE x <> 'already_production' AND x NOT LIKE 'other\_staging\_orgs:%' AND x NOT LIKE 'daftra\_not\_cleared:%';
  IF NOT EXISTS (SELECT 1 FROM app.org_conversions c WHERE c.org_id = p_org) THEN
    v_out := v_out || 'never_converted'::text;
  END IF;
  RETURN v_out;
END $$;

-- the wipe: the first conversion's delete, unchanged (app.convert_delete_tables in ONE statement with the listed guards
-- disabled for that statement only, then the memberships except the platform admins' admin one, org_counters,
-- org_usage_counters recounted; MOCK channels switched off). Called only by public.reconvert_org.
CREATE OR REPLACE FUNCTION app.reconvert_wipe(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_g        text;
  v_t        text;
  v_sql      text := '';
  v_sel      text := '';
  v_deleted  jsonb;
  v_members  int;
  v_counters int;
  v_usage    int;
  v_mock     int;
  v_prev_bl  text := coalesce(current_setting('marsa.g3_bl_batch', true), '');
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'sql_editor_only');
  END IF;
  UPDATE public.msg_channels c SET ingest_enabled = false, send_enabled = false, status = 'disabled'
   WHERE c.org_id = p_org AND c.mode = 'mock' AND (c.ingest_enabled OR c.send_enabled OR c.status <> 'disabled');
  GET DIAGNOSTICS v_mock = ROW_COUNT;

  FOREACH v_g IN ARRAY app.convert_delete_guards() LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', split_part(v_g, ':', 1), split_part(v_g, ':', 2));
  END LOOP;
  PERFORM set_config('marsa.g3_bl_batch', 'on', true);
  FOREACH v_t IN ARRAY app.convert_delete_tables() LOOP
    v_sql := v_sql || CASE WHEN v_sql = '' THEN 'WITH ' ELSE ', ' END
             || format('%I AS (DELETE FROM %s WHERE org_id = $1 RETURNING 1)', 'd_' || split_part(v_t, '.', 2), v_t);
    v_sel := v_sel || CASE WHEN v_sel = '' THEN '' ELSE ', ' END
             || format('(%L, (SELECT count(*) FROM %I))', split_part(v_t, '.', 2), 'd_' || split_part(v_t, '.', 2));
  END LOOP;
  EXECUTE v_sql || ' SELECT jsonb_object_agg(v.t, v.n) FROM (VALUES ' || v_sel || ') v(t, n)' INTO v_deleted USING p_org;
  PERFORM set_config('marsa.g3_bl_batch', v_prev_bl, true);
  FOREACH v_g IN ARRAY app.convert_delete_guards() LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', split_part(v_g, ':', 1), split_part(v_g, ':', 2));
  END LOOP;
  IF EXISTS (SELECT 1 FROM unnest(app.convert_delete_guards()) g
              JOIN pg_trigger t ON t.tgrelid = split_part(g, ':', 1)::regclass AND t.tgname = split_part(g, ':', 2)
             WHERE t.tgenabled <> 'O') THEN
    PERFORM app.fail('MRS_INVALID', 'guard_not_reenabled');
  END IF;

  DELETE FROM public.memberships m
   WHERE m.org_id = p_org
     AND NOT (m.role = 'admin' AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = m.user_id));
  GET DIAGNOSTICS v_members = ROW_COUNT;
  -- every reference restarts at …-000001: <prefix>- / REQ- / MSG- / IMP- (yearly) and PAY- / CUS- (year 0), this org only
  DELETE FROM public.org_counters c WHERE c.org_id = p_org;
  GET DIAGNOSTICS v_counters = ROW_COUNT;
  DELETE FROM public.org_usage_counters u WHERE u.org_id = p_org;
  GET DIAGNOSTICS v_usage = ROW_COUNT;
  PERFORM app.g7_recount(p_org);
  RETURN jsonb_build_object('deleted', v_deleted, 'memberships', v_members, 'org_counters', v_counters,
                            'org_usage_counters', v_usage, 'mock_channels_disabled', v_mock);
END $$;

-- readiness after the run (read-only; no TOTP item: MFA is off by the owner's decision, 20261129000100)
CREATE OR REPLACE FUNCTION app.reconvert_ready(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o     public.organizations;
  v_t   text;
  v_n   bigint;
  v_left text[] := ARRAY[]::text[];
  v_bl  text[];
  v_st  jsonb;
BEGIN
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org;
  IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'blockers', jsonb_build_array('org_not_found')); END IF;
  FOREACH v_t IN ARRAY app.convert_delete_tables() LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE org_id = $1', v_t) INTO v_n USING p_org;
    IF v_n > 0 THEN v_left := v_left || (split_part(v_t, '.', 2) || ':' || v_n); END IF;
  END LOOP;
  v_bl := array_remove(ARRAY[
    CASE WHEN app.deploy_environment() <> 'production' THEN 'deploy_environment_not_production' END,
    CASE WHEN o.environment <> 'production' THEN 'org_not_production' END,
    CASE WHEN app.is_demo_org(o) THEN 'demo_org' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.platform_admins pa ON pa.user_id = m.user_id
                           WHERE m.org_id = p_org AND m.role = 'admin' AND m.is_active) THEN 'owner_admin_membership_missing' END,
    CASE WHEN cardinality(v_left) > 0 THEN 'rows_left:' || array_to_string(v_left, ',') END,
    CASE WHEN EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.org_id = p_org AND c.mode = 'mock' AND (c.ingest_enabled OR c.send_enabled))
         THEN 'mock_channel_active' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity) THEN 'public_tables_without_rls' END
  ]::text[], NULL);
  -- the uploaded files of the wiped rows stay in Storage until the owner empties '<org>/' in the three buckets (runbook
  -- step «التخزين»): listed as a to-do, not a blocker (the folders are emptied after the run)
  v_st := app.convert_storage_objects(p_org);
  RETURN jsonb_build_object('ok', cardinality(v_bl) = 0, 'blockers', to_jsonb(v_bl),
                            'todo', to_jsonb(array_remove(ARRAY[
                              CASE WHEN coalesce((v_st ->> 'documents')::int, 0) + coalesce((v_st ->> 'finance')::int, 0)
                                        + coalesce((v_st ->> 'messages')::int, 0) > 0
                                   THEN 'storage_objects_left:' || (v_st ->> 'folder') END,
                              CASE WHEN v_st ? 'note' THEN 'storage_objects_unknown:' || (v_st ->> 'folder') END]::text[], NULL)),
                            'slug', o.slug, 'ref_prefix', o.ref_prefix, 'next_transaction_ref',
                            o.ref_prefix || '-' || extract(year FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int || '-' ||
                            lpad((coalesce((SELECT c.last_value FROM public.org_counters c WHERE c.org_id = p_org AND c.scope = 'transaction'
                                              AND c.year = extract(year FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int), 0) + 1)::text, 6, '0'),
                            'mfa_required', false);
END $$;

-- ---------------------------------------------------------------------
-- 5. preview (read-only; SQL Editor only)
-- ---------------------------------------------------------------------
-- SELECT public.reconvert_org_preview('<org uuid>', '<new-slug>', '<NEW PREFIX>');
CREATE OR REPLACE FUNCTION public.reconvert_org_preview(p_org uuid, p_slug text DEFAULT NULL, p_ref_prefix text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o       public.organizations;
  v_t     text;
  v_n     bigint;
  v_rows  jsonb := '{}'::jsonb;
  v_keep  jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_err   text[];
  v_slug  text := lower(btrim(coalesce(p_slug, '')));
  v_pfx   text := upper(btrim(coalesce(p_ref_prefix, '')));
  v_daf   jsonb;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'sql_editor_only');
  END IF;
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org;
  IF o.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'organization'); END IF;
  FOREACH v_t IN ARRAY app.convert_delete_tables() LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE org_id = $1', v_t) INTO v_n USING p_org;
    v_rows := v_rows || jsonb_build_object(split_part(v_t, '.', 2), v_n);
    v_total := v_total + v_n;
  END LOOP;
  FOREACH v_t IN ARRAY app.convert_keep_tables() LOOP
    IF v_t IN ('public.memberships', 'public.org_counters', 'public.org_usage_counters') THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %s WHERE org_id = $1', v_t) INTO v_n USING p_org;
    v_keep := v_keep || jsonb_build_object(v_t, v_n);
  END LOOP;
  v_err := CASE WHEN p_slug IS NULL AND p_ref_prefix IS NULL THEN ARRAY['slug_and_prefix_not_given']
                ELSE app.reconvert_input_errors(p_org, p_slug, p_ref_prefix, NULL, NULL) END;
  v_daf := app.convert_daftra_pushed(p_org);
  RETURN jsonb_build_object(
    'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en, 'ref_prefix', o.ref_prefix,
    'environment', o.environment, 'deploy_environment', app.deploy_environment(),
    'runs_before', (SELECT coalesce(jsonb_agg(jsonb_build_object('run_no', c.run_no, 'kind', c.kind, 'from_slug', c.from_slug,
                                                                  'to_slug', c.to_slug, 'converted_at', c.converted_at) ORDER BY c.run_no), '[]'::jsonb)
                      FROM app.org_conversions c WHERE c.org_id = p_org),
    'new_slug', nullif(v_slug, ''), 'new_ref_prefix', nullif(v_pfx, ''),
    'first_transaction_ref_after', CASE WHEN cardinality(v_err) = 0
                                        THEN v_pfx || '-' || extract(year FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int || '-000001' END,
    'confirm_phrase', CASE WHEN cardinality(v_err) = 0 THEN 'WIPE-ALL-DATA-' || o.slug || '-TO-' || v_slug || '-' || v_pfx END,
    'input_errors', to_jsonb(v_err),
    'used_prefixes', to_jsonb(app.reconvert_used_prefixes(p_org)),
    'reserved_prefixes', to_jsonb(app.reconvert_reserved_prefixes()),
    'would_delete', v_rows, 'would_delete_total', v_total,
    'kept', v_keep,
    'counters_reset', (SELECT coalesce(jsonb_agg(jsonb_build_object('scope', c.scope, 'year', c.year, 'last_value', c.last_value)
                                                 ORDER BY c.scope, c.year), '[]'::jsonb)
                         FROM public.org_counters c WHERE c.org_id = p_org),
    'memberships_kept', (SELECT coalesce(jsonb_agg(jsonb_build_object('email', app.mask_email(u.email), 'role', m.role)
                                                   ORDER BY u.email), '[]'::jsonb)
                           FROM public.memberships m JOIN public.platform_admins pa ON pa.user_id = m.user_id
                           LEFT JOIN auth.users u ON u.id = m.user_id
                          WHERE m.org_id = p_org AND m.role = 'admin'),
    'memberships_removed', (SELECT coalesce(jsonb_agg(jsonb_build_object('email', app.mask_email(u.email), 'role', m.role)
                                                      ORDER BY u.email, m.role), '[]'::jsonb)
                              FROM public.memberships m LEFT JOIN auth.users u ON u.id = m.user_id
                             WHERE m.org_id = p_org
                               AND NOT (m.role = 'admin' AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = m.user_id))),
    'branches', (SELECT coalesce(jsonb_agg(b.code ORDER BY b.code), '[]'::jsonb) FROM public.branches b WHERE b.org_id = p_org),
    'msg_channels', (SELECT coalesce(jsonb_agg(jsonb_build_object('address', c.address, 'mode', c.mode, 'status', c.status)
                                               ORDER BY c.address), '[]'::jsonb)
                       FROM public.msg_channels c WHERE c.org_id = p_org),
    'accounting_link', (SELECT jsonb_build_object('mode', d.mode, 'status', d.status, 'subdomain', d.subdomain)
                          FROM public.daftra_connections d WHERE d.org_id = p_org),
    'ai_settings_kept', EXISTS (SELECT 1 FROM app.ai_settings s WHERE s.org_id = p_org),
    'storage_objects', app.convert_storage_objects(p_org),
    'daftra_pushed', v_daf - 'connection',
    'accounts_without_access_after', app.convert_accounts_without_access(p_org),
    'warnings', to_jsonb(array_remove(ARRAY[
      CASE WHEN v_daf ->> 'ack' IS NOT NULL THEN 'daftra_documents_exist:' || (v_daf ->> 'invoices') || '-' || (v_daf ->> 'clients') END,
      CASE WHEN EXISTS (SELECT 1 FROM public.organizations x WHERE x.id <> p_org AND x.ref_prefix = v_pfx) THEN 'ref_prefix_used_by_another_org' END
    ]::text[], NULL)),
    'blockers', to_jsonb(app.reconvert_check(p_org)));
END $$;

-- ---------------------------------------------------------------------
-- 6. the re-conversion (SQL Editor only)
-- ---------------------------------------------------------------------
-- SELECT public.reconvert_org('<org uuid>', '<slug>', '<PREFIX>', 'WIPE-ALL-DATA-<current-slug>-TO-<slug>-<PREFIX>', '<name_ar>|NULL', '<name_en>|NULL');
CREATE OR REPLACE FUNCTION public.reconvert_org(p_org uuid, p_slug text, p_ref_prefix text, p_confirm text,
                                                p_name_ar text DEFAULT NULL, p_name_en text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o          public.organizations;
  n          public.organizations;
  v_slug     text := lower(btrim(coalesce(p_slug, '')));
  v_prefix   text := upper(btrim(coalesce(p_ref_prefix, '')));
  v_err      text[];
  v_block    text[];
  v_storage  jsonb;
  v_daftra   jsonb;
  v_w        jsonb;
  v_noacc    jsonb;
  v_total    bigint;
  v_run      int;
  v_summary  jsonb;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'sql_editor_only');
  END IF;
  PERFORM set_config('lock_timeout', '15s', true);
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org FOR UPDATE;
  IF o.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'organization'); END IF;
  v_err := app.reconvert_input_errors(p_org, p_slug, p_ref_prefix, p_name_ar, p_name_en);
  IF cardinality(v_err) > 0 THEN PERFORM app.fail('MRS_INVALID', array_to_string(v_err, ' ')); END IF;
  -- the phrase names the org being wiped (its current slug) and the new slug / prefix
  IF p_confirm IS DISTINCT FROM 'WIPE-ALL-DATA-' || o.slug || '-TO-' || v_slug || '-' || v_prefix THEN
    PERFORM app.fail('MRS_INVALID', 'confirm');
  END IF;
  v_block := app.reconvert_check(p_org);
  IF cardinality(v_block) > 0 THEN PERFORM app.fail('MRS_FORBIDDEN', array_to_string(v_block, ' ')); END IF;

  v_storage := app.convert_storage_objects(p_org);
  v_daftra := app.convert_daftra_pushed(p_org);
  v_w := app.reconvert_wipe(p_org);
  v_noacc := app.convert_accounts_without_access(p_org);

  UPDATE public.organizations x
     SET slug = v_slug, ref_prefix = v_prefix,
         name_ar = coalesce(nullif(btrim(p_name_ar), ''), x.name_ar),
         name_en = CASE WHEN p_name_en IS NULL THEN x.name_en ELSE nullif(btrim(p_name_en), '') END
   WHERE x.id = p_org
  RETURNING * INTO n;

  SELECT sum(value::bigint) INTO v_total FROM jsonb_each_text(v_w -> 'deleted');
  SELECT coalesce(max(c.run_no), 1) + 1 INTO v_run FROM app.org_conversions c WHERE c.org_id = p_org;
  v_summary := jsonb_build_object(
    'org_id', p_org, 'run_no', v_run, 'kind', 'reconvert',
    'from_slug', o.slug, 'slug', n.slug, 'from_ref_prefix', o.ref_prefix, 'ref_prefix', n.ref_prefix,
    'from_name_ar', o.name_ar, 'name_ar', n.name_ar, 'name_en', n.name_en, 'environment', n.environment,
    'deleted', (v_w -> 'deleted') || jsonb_build_object('memberships', (v_w ->> 'memberships')::int),
    'deleted_total', v_total + (v_w ->> 'memberships')::int,
    'reset', jsonb_build_object('org_counters', (v_w ->> 'org_counters')::int, 'org_usage_counters', (v_w ->> 'org_usage_counters')::int),
    'mock_channels_disabled', (v_w ->> 'mock_channels_disabled')::int,
    'guards_bypassed', cardinality(app.convert_delete_guards()),
    'kept', jsonb_build_object(
      'branches',    (SELECT count(*) FROM public.branches b WHERE b.org_id = p_org),
      'memberships', (SELECT count(*) FROM public.memberships m WHERE m.org_id = p_org),
      'msg_channels', (SELECT count(*) FROM public.msg_channels c WHERE c.org_id = p_org),
      'daftra_connections', (SELECT count(*) FROM public.daftra_connections d WHERE d.org_id = p_org),
      'ai_settings', (SELECT count(*) FROM app.ai_settings s WHERE s.org_id = p_org),
      'audit_log',   (SELECT count(*) FROM public.audit_log a WHERE a.org_id = p_org)),
    'storage_objects_left', v_storage,
    'daftra_documents_left', v_daftra - 'connection',
    'accounts_without_access', v_noacc);

  INSERT INTO app.org_conversions (org_id, run_no, kind, from_slug, to_slug, converted_by, summary)
  VALUES (p_org, v_run, 'reconvert', o.slug, n.slug, left(session_user::text, 63), v_summary);

  RETURN v_summary || jsonb_build_object('ready', app.reconvert_ready(p_org), 'health_check', public.health_check());
END $$;

-- ---------------------------------------------------------------------
-- 7. privileges: SQL Editor (postgres) only — no API role, not even the Edge Functions' service_role
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.reconvert_reserved_prefixes(), app.reconvert_used_prefixes(uuid),
  app.reconvert_input_errors(uuid, text, text, text, text), app.reconvert_check(uuid), app.reconvert_wipe(uuid),
  app.reconvert_ready(uuid), app.next_org_seq(uuid, text), app.tg_org_seq(), app.msg_tx_ref_ok(text)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reconvert_org_preview(uuid, text, text),
  public.reconvert_org(uuid, text, text, text, text, text)
FROM PUBLIC, anon, authenticated, service_role;
-- review_msg_extraction: CREATE OR REPLACE keeps its ACL (20261107000100); restated
REVOKE ALL ON FUNCTION public.review_msg_extraction(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_msg_extraction(uuid, text, text, text) TO authenticated;
