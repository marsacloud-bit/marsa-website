-- =====================================================================
-- Marsa — 20261115000100 — convert the CURRENT (staging) project into production IN PLACE (owner decision 2026-11-08:
-- the Supabase project cgzhidyxfpksfckwmauq and marsacloud.com become production; no new project).
-- Builds on ai_documents (20261114000100). Owner runbook: docs/online/CONVERT_IN_PLACE_AR.md.
-- Applying this file changes NO data: it only adds the functions below. The conversion runs when the owner calls
--   SELECT public.convert_org_to_production('<org uuid>', '<new-slug>', '<الاسم العربي>', '<English name>',
--                                           'DELETE-TEST-DATA-<new-slug>');
-- from the SQL Editor (postgres, no JWT claims), once, after a backup.
--   P. preflight (ai_documents applied) + schema_versions row
--   0. table        app.org_conversions: one row per converted org (from / to slug, who, when, the summary);
--                   append-only (no UPDATE / DELETE / TRUNCATE); schema app, RLS on, no API grant
--   1. helpers      app.convert_delete_tables()  the org-scoped tables whose rows are TEST data (deleted)
--                   app.convert_keep_tables()    the org-scoped tables that are kept (configuration, identity, logs)
--                   app.convert_delete_guards()  the BEFORE DELETE guards on deleted tables (bypassed inside the
--                                                conversion only: DISABLE → one DELETE statement → ENABLE)
--                   app.convert_check(org)       the refusals shared by preview and conversion
--                   app.convert_daftra_pushed(org)  the test invoices / clients sent to Daftra (must be removed there first)
--                   app.convert_accounts_without_access(org)  sign-in accounts left without any membership
--                   app.tg_org_conversions_guard()
--   2. preview      public.convert_org_preview(org)  read-only: rows per table that WOULD be deleted, memberships kept /
--                                                    removed, storage objects, Daftra documents to remove, accounts left
--                                                    without access, kept configuration to review, warnings, blockers.
--                                                    SQL Editor only.
--   3. conversion   public.convert_org_to_production(org, slug, name_ar, name_en, confirm). SQL Editor only.
--   4. privileges   every function / table of this file: no API role (not even service_role)
--
-- What the conversion DELETES (the org's rows only, app.convert_delete_tables): requests, clients (+ aliases, portal
-- users), invitations, idempotency replays, imports, transactions (+ events, B/Ls, declarations, containers, documents,
-- OCR / AI readings), parties, fleet, trips, appointments, demurrage, exceptions, alerts, costs (accruals, adjustments,
-- allocations, client charges, collections, supplier invoices / lines / payments, finance documents), billing (intents,
-- lines, review items, sync jobs + attempts, Daftra client links, Daftra MOCK accounts), contact messages, the inbox
-- (threads, messages, events, attachments, extractions, summaries, classifications, AI runs, replies + versions +
-- approvals, outbound + delivery events, jobs + attempts, thread links, contacts + addresses + authorizations, MOCK
-- mailboxes), every membership except the platform admins' 'admin' membership; resets org_counters (references start
-- again at …-000001) and org_usage_counters (recounted from the now empty tables).
-- What it KEEPS: the org row (renamed, environment 'production', staging / demo / note keys removed from settings),
-- branches, the platform admins' admin membership, msg_channels (MOCK channels are switched off: they cannot be
-- deleted), msg_settings / auto-reply policies / templates / instructions, daftra_connections, daftra_item_links,
-- document_requirements, the subscription (+ its append-only events), app.ai_settings, and the append-only logs
-- audit_log, report_exports, app.ai_usage, operational_alert_runs, client_errors (purged by its cron job).
-- Attempt logs (billing_sync_attempts, msg_job_attempts) cannot stay: their foreign key needs the deleted job.
-- Append-only guards: the deleted tables' BEFORE DELETE guards (app.convert_delete_guards, 23 triggers) are disabled
-- for the ONE delete statement and enabled again in the same transaction (ALTER TABLE … DISABLE / ENABLE TRIGGER is
-- transactional: an error anywhere rolls everything back, guards included). The kept append-only tables are never
-- touched. Every deleted row still leaves its AFTER DELETE audit row (trg_audit) in public.audit_log.
-- Daftra (review D1): operational_ref (= MRS-<year>-<n>/<purpose key>) restarts with the transaction numbering, and the
-- worker adopts an existing Daftra invoice with the same reference. So the conversion refuses
-- (daftra_not_cleared:DAFTRA-CLEARED-<invoices>-<clients>) while test invoices / client links exist, until the owner has
-- deleted them in Daftra (list: preview → daftra_pushed) or switched to a new Daftra account, and sets, in the same Run:
--   SELECT set_config('marsa.convert_daftra_ack', 'DAFTRA-CLEARED-<invoices>-<clients>', false);
-- The value must match the current counts exactly; the conversion clears it again.
-- Accounts (review D2): auth.* is not touched. Accounts left without any membership are listed (preview →
-- accounts_without_access_after, summary → accounts_without_access) and deleted by the owner from the Dashboard;
-- post_install_checks.sql reports auth_users_without_access.
-- Storage: rows of storage.objects are NOT deleted (Supabase refuses direct deletes; the file would stay anyway). The
-- result reports the objects under '<org_id>/' in buckets documents / finance / messages; the owner empties those
-- folders from the Dashboard (runbook).
-- set_deploy_environment (20261112000100) is called unchanged: after the conversion the org is neither a demo org
-- (not the seed slug, no settings.demo) nor a 'staging' org, so its existing guards pass; the seed slug and any other
-- staging org are still refused. supabase/production/post_install_checks.sql treats the seed ids of a converted org
-- (recorded in app.org_conversions) as kept, not as demo / seed rows.
-- Re-runnable file (CREATE ... IF NOT EXISTS / CREATE OR REPLACE). The conversion itself runs once: a second call is
-- refused (MRS_BAD_TRANSITION already_production).
-- Down-path (before a conversion only): DROP FUNCTION public.convert_org_to_production(uuid, text, text, text, text),
-- public.convert_org_preview(uuid) and the app.convert_* helpers; DROP TABLE app.org_conversions. After a conversion
-- the only way back is a restore of the backup taken before it.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261114000100') THEN
    RAISE EXCEPTION 'CONVERT preflight: apply ai_documents first (schema_versions lacks 20261114000100 ai_documents)';
  END IF;
  IF to_regprocedure('public.set_deploy_environment(text)') IS NULL OR to_regclass('app.deploy_settings') IS NULL THEN
    RAISE EXCEPTION 'CONVERT preflight: deploy_env missing (apply 20261112000100_deploy_env.sql)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261115000100', 'convert_in_place')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. the conversion record (one row per org; written only by convert_org_to_production)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.org_conversions (
  org_id        uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  from_slug     text NOT NULL,
  to_slug       text NOT NULL,
  converted_at  timestamptz NOT NULL DEFAULT now(),
  converted_by  text NOT NULL CHECK (char_length(converted_by) <= 63),     -- session_user of the SQL Editor
  summary       jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object')
);
COMMENT ON TABLE app.org_conversions IS 'In-place staging → production conversions (public.convert_org_to_production). Append-only record: from / to slug, who, when, rows deleted per table. Read by supabase/production/post_install_checks.sql (the kept seed ids of a converted org are not demo / seed rows).';
ALTER TABLE app.org_conversions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.org_conversions FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app.tg_org_conversions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM app.fail('MRS_APPEND_ONLY', 'org_conversions');
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_append_only ON app.org_conversions;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON app.org_conversions
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_conversions_guard();
DROP TRIGGER IF EXISTS trg_append_only_trunc ON app.org_conversions;
CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON app.org_conversions
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_org_conversions_guard();

-- ---------------------------------------------------------------------
-- 1. helpers
-- ---------------------------------------------------------------------
-- org-scoped tables whose rows are test business data (all rows WHERE org_id = <org> are deleted in ONE statement,
-- so the foreign-key cycles between them never matter: NO ACTION checks run at the end of the statement)
CREATE OR REPLACE FUNCTION app.convert_delete_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    -- intake / clients / access
    'public.service_requests', 'public.clients', 'public.client_aliases', 'public.client_users', 'public.invitations',
    'public.idempotency_keys', 'public.import_batches', 'public.import_rows', 'public.contact_messages',
    -- operations
    'public.transactions', 'public.transaction_events', 'public.transaction_bls', 'public.bills_of_lading',
    'public.customs_declarations', 'public.containers', 'public.documents', 'public.document_extractions',
    'public.parties', 'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
    'public.demurrage_cases', 'public.operational_exceptions', 'public.operational_alerts',
    -- costs (G4)
    'public.cost_accruals', 'public.cost_adjustments', 'public.cost_allocations', 'public.client_charges',
    'public.charge_collections', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.supplier_payments',
    'public.finance_documents',
    -- billing (G5)
    'public.billing_intents', 'public.billing_intent_lines', 'public.billing_review_items', 'public.billing_sync_jobs',
    'public.billing_sync_attempts', 'public.daftra_client_links', 'public.daftra_mock_accounts',
    -- inbox (G6b)
    'public.msg_threads', 'public.msg_messages', 'public.msg_message_events', 'public.msg_attachments',
    'public.msg_extractions', 'public.msg_summaries', 'public.msg_classifications', 'public.msg_ai_runs',
    'public.msg_replies', 'public.msg_reply_versions', 'public.msg_reply_approvals', 'public.msg_outbound',
    'public.msg_delivery_events', 'public.msg_jobs', 'public.msg_job_attempts', 'public.msg_thread_links',
    'public.msg_contacts', 'public.msg_contact_addresses', 'public.msg_contact_authorizations', 'public.msg_mock_mailboxes'
  ]::text[]
$$;

-- org-scoped tables that are kept (memberships / org_counters / org_usage_counters are handled on their own)
CREATE OR REPLACE FUNCTION app.convert_keep_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.branches', 'public.memberships', 'public.org_counters', 'public.org_usage_counters',
    'public.msg_channels', 'public.msg_settings', 'public.msg_auto_reply_policies', 'public.msg_templates',
    'public.msg_instructions', 'public.daftra_connections', 'public.daftra_item_links', 'public.document_requirements',
    'public.org_subscriptions', 'public.subscription_events', 'app.ai_settings',
    -- append-only / log tables
    'public.audit_log', 'public.report_exports', 'app.ai_usage', 'public.operational_alert_runs', 'public.client_errors'
  ]::text[]
$$;

-- the BEFORE DELETE guards on deleted tables (table:trigger). The conversion refuses to run when a deleted table
-- carries any other BEFORE DELETE trigger (a guard added later must be reviewed, never bypassed silently).
CREATE OR REPLACE FUNCTION app.convert_delete_guards() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.transaction_events:trg_append_only', 'public.charge_collections:trg_append_only',
    'public.supplier_payments:trg_append_only', 'public.billing_sync_attempts:trg_append_only',
    'public.msg_ai_runs:trg_append_only', 'public.msg_attachments:trg_append_only',
    'public.msg_classifications:trg_append_only', 'public.msg_delivery_events:trg_append_only',
    'public.msg_extractions:trg_append_only', 'public.msg_job_attempts:trg_append_only',
    'public.msg_message_events:trg_append_only', 'public.msg_messages:trg_append_only',
    'public.msg_outbound:trg_append_only', 'public.msg_reply_approvals:trg_append_only',
    'public.msg_reply_versions:trg_append_only', 'public.msg_summaries:trg_append_only',
    'public.msg_thread_links:trg_append_only',
    'public.msg_contact_addresses:trg_no_delete', 'public.msg_contact_authorizations:trg_no_delete',
    'public.msg_contacts:trg_no_delete', 'public.msg_jobs:trg_no_delete', 'public.msg_replies:trg_no_delete',
    'public.msg_threads:trg_no_delete'
  ]::text[]
$$;

-- the refusals shared by the preview and the conversion (an empty array = the conversion may run)
CREATE OR REPLACE FUNCTION app.convert_check(p_org uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o     public.organizations;
  v_out text[] := ARRAY[]::text[];
  v_x   text;
BEGIN
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org;
  IF o.id IS NULL THEN RETURN ARRAY['org_not_found']; END IF;
  IF o.environment = 'production' OR app.deploy_environment() = 'production'
     OR EXISTS (SELECT 1 FROM app.org_conversions c WHERE c.org_id = p_org) THEN
    v_out := v_out || 'already_production'::text;
  END IF;
  -- the deploy switch needs every OTHER org to be neither demo nor staging (the conversion handles only this one)
  SELECT string_agg(x.slug, ',' ORDER BY x.slug) INTO v_x FROM public.organizations x
   WHERE x.id <> p_org AND (x.environment <> 'production' OR app.is_demo_org(x));
  IF v_x IS NOT NULL THEN v_out := v_out || ('other_staging_orgs:' || v_x); END IF;
  -- the owner must keep access: a platform admin with an active 'admin' membership of this org
  IF NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.platform_admins pa ON pa.user_id = m.user_id
                  WHERE m.org_id = p_org AND m.role = 'admin' AND m.is_active) THEN
    v_out := v_out || 'owner_admin_membership_missing'::text;
  END IF;
  -- every org-scoped table must be classified (a table added later is never left with test rows unnoticed)
  SELECT string_agg(t, ',' ORDER BY t) INTO v_x FROM (
    SELECT n.nspname || '.' || c.relname t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
       AND n.nspname || '.' || c.relname <> 'app.org_conversions') x
   WHERE NOT (t = ANY (app.convert_delete_tables() || app.convert_keep_tables()));
  IF v_x IS NOT NULL THEN v_out := v_out || ('unclassified_tables:' || v_x); END IF;
  -- every enabled BEFORE DELETE row trigger on a deleted table must be a listed guard
  SELECT string_agg(t, ',' ORDER BY t) INTO v_x FROM (
    SELECT 'public.' || c.relname || ':' || g.tgname t
      FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
     WHERE NOT g.tgisinternal AND g.tgenabled <> 'D' AND c.relnamespace = 'public'::regnamespace
       AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8          -- ROW, BEFORE, DELETE
       AND ('public.' || c.relname) = ANY (app.convert_delete_tables())) x
   WHERE NOT (t = ANY (app.convert_delete_guards()));
  IF v_x IS NOT NULL THEN v_out := v_out || ('unexpected_delete_guards:' || v_x); END IF;
  -- D1: test documents pushed to Daftra must be removed there first, then acknowledged (runbook section 4)
  v_x := app.convert_daftra_pushed(p_org) ->> 'ack';
  IF v_x IS NOT NULL AND coalesce(current_setting('marsa.convert_daftra_ack', true), '') IS DISTINCT FROM v_x THEN
    v_out := v_out || ('daftra_not_cleared:' || v_x);
  END IF;
  RETURN v_out;
END $$;

-- objects of the org's folders in the private buckets (Supabase Storage keeps the files: emptied from the Dashboard)
CREATE OR REPLACE FUNCTION app.convert_storage_objects(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  BEGIN
    SELECT jsonb_build_object(
             'documents', count(*) FILTER (WHERE o.bucket_id = 'documents'),
             'finance',   count(*) FILTER (WHERE o.bucket_id = 'finance'),
             'messages',  count(*) FILTER (WHERE o.bucket_id = 'messages'),
             'folder',    p_org::text || '/')
      INTO v
      FROM storage.objects o
     WHERE o.bucket_id IN ('documents', 'finance', 'messages') AND o.name LIKE p_org::text || '/%';
  EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
    v := jsonb_build_object('documents', NULL, 'finance', NULL, 'messages', NULL, 'folder', p_org::text || '/',
                            'note', 'storage.objects not readable here');
  END;
  RETURN v;
END $$;

-- what the test data pushed to Daftra (D1). The worker sends operational_ref = <transaction ref>/<purpose key> and looks
-- an invoice up by that reference before creating it (daftra-sync findInvoiceByReference), and a client by VAT number
-- (findClientsByVat). The conversion restarts MRS- at 000001, so a test draft left in the Daftra account would be
-- adopted by the first REAL invoice with the same reference. Every billing intent that ever left 'idle' (sent, in flight
-- or unknown) and every Daftra client link is listed; the conversion runs only after the owner has removed them from
-- Daftra (or uses a new Daftra account) and acknowledged it with marsa.convert_daftra_ack = the 'ack' value below.
CREATE OR REPLACE FUNCTION app.convert_daftra_pushed(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n_inv int;
  n_cli int;
BEGIN
  SELECT count(*) INTO n_inv FROM public.billing_intents b
   WHERE b.org_id = p_org
     AND (b.external_invoice_id IS NOT NULL OR b.daftra_number IS NOT NULL OR b.pushed_at IS NOT NULL OR b.sync_state <> 'idle');
  SELECT count(*) INTO n_cli FROM public.daftra_client_links l WHERE l.org_id = p_org;
  RETURN jsonb_build_object(
    'invoices', n_inv,
    'clients', n_cli,
    'ack', CASE WHEN n_inv + n_cli > 0 THEN 'DAFTRA-CLEARED-' || n_inv || '-' || n_cli END,
    'connection', (SELECT jsonb_build_object('mode', d.mode, 'status', d.status, 'subdomain', d.subdomain)
                     FROM public.daftra_connections d WHERE d.org_id = p_org),
    'invoice_list', (SELECT coalesce(jsonb_agg(x.j ORDER BY x.r, x.k), '[]'::jsonb) FROM (
                       SELECT b.operational_ref r, b.revision k,
                              jsonb_build_object('operational_ref', b.operational_ref, 'external_invoice_id', b.external_invoice_id,
                                                 'daftra_number', b.daftra_number, 'status', b.status, 'sync_state', b.sync_state) j
                         FROM public.billing_intents b
                        WHERE b.org_id = p_org
                          AND (b.external_invoice_id IS NOT NULL OR b.daftra_number IS NOT NULL OR b.pushed_at IS NOT NULL
                               OR b.sync_state <> 'idle')
                        ORDER BY b.operational_ref, b.revision LIMIT 500) x),
    'client_list', (SELECT coalesce(jsonb_agg(x.j ORDER BY x.r), '[]'::jsonb) FROM (
                      SELECT l.client_ref r,
                             jsonb_build_object('client_name', c.name_ar, 'vat_number', c.vat_number, 'external_id', l.external_id,
                                                'status', l.status) j
                        FROM public.daftra_client_links l LEFT JOIN public.clients c ON c.id = l.client_id
                       WHERE l.org_id = p_org
                       ORDER BY l.client_ref LIMIT 500) x));
END $$;

-- sign-in accounts left with no access after the conversion (D2): not a platform admin and no membership outside the
-- org being converted (every membership of that org except the platform admins' admin one is deleted). The conversion
-- does not touch auth.*: the owner deletes these accounts (Authentication → Users), runbook section 8.
CREATE OR REPLACE FUNCTION app.convert_accounts_without_access(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
           'count', count(*),
           'emails', coalesce((jsonb_agg(app.mask_email(lower(x.email)) ORDER BY lower(x.email)) FILTER (WHERE x.rn <= 200)), '[]'::jsonb))
    FROM (SELECT u.email, row_number() OVER (ORDER BY lower(u.email)) rn
            FROM auth.users u
           WHERE NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id AND m.org_id <> p_org AND m.is_active)) x
$$;

-- ---------------------------------------------------------------------
-- 2. preview (read-only; SQL Editor only)
-- ---------------------------------------------------------------------
-- SELECT public.convert_org_preview('<org uuid>');
CREATE OR REPLACE FUNCTION public.convert_org_preview(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o       public.organizations;
  v_t     text;
  v_n     bigint;
  v_rows  jsonb := '{}'::jsonb;
  v_total bigint := 0;
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
  RETURN jsonb_build_object(
    'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'environment', o.environment,
    'deploy_environment', app.deploy_environment(),
    'would_delete', v_rows, 'would_delete_total', v_total,
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
    'storage_objects', app.convert_storage_objects(p_org),
    -- D1: what to delete in Daftra first (ack = the value of marsa.convert_daftra_ack once done)
    'daftra_pushed', app.convert_daftra_pushed(p_org),
    -- D2: accounts that keep their password but lose every membership (deleted by the owner, runbook section 8)
    'accounts_without_access_after', app.convert_accounts_without_access(p_org),
    'platform_admins', (SELECT coalesce(jsonb_agg(app.mask_email(lower(u.email)) ORDER BY lower(u.email)), '[]'::jsonb)
                          FROM public.platform_admins pa LEFT JOIN auth.users u ON u.id = pa.user_id),
    -- D5: kept configuration that may still hold test wording (reviewed after the conversion, runbook section 12)
    'kept_config_review', jsonb_build_object(
      'msg_templates',           (SELECT count(*) FROM public.msg_templates t WHERE t.org_id = p_org),
      'msg_instructions',        (SELECT count(*) FROM public.msg_instructions t WHERE t.org_id = p_org),
      'msg_auto_reply_policies', (SELECT count(*) FROM public.msg_auto_reply_policies t WHERE t.org_id = p_org),
      'document_requirements',   (SELECT count(*) FROM public.document_requirements t WHERE t.org_id = p_org),
      'daftra_item_links',       (SELECT count(*) FROM public.daftra_item_links t WHERE t.org_id = p_org)),
    'warnings', to_jsonb(array_remove(ARRAY[
      CASE WHEN (SELECT count(*) FROM public.memberships m JOIN public.platform_admins pa ON pa.user_id = m.user_id
                  WHERE m.org_id = p_org AND m.role = 'admin') > 1 THEN 'several_admin_memberships_kept' END,
      CASE WHEN (SELECT count(*) FROM public.platform_admins) > 1 THEN 'several_platform_admins' END
    ]::text[], NULL)),
    'blockers', to_jsonb(app.convert_check(p_org)));
END $$;

-- ---------------------------------------------------------------------
-- 3. the conversion (SQL Editor only)
-- ---------------------------------------------------------------------
-- SELECT public.convert_org_to_production('<org uuid>', '<slug>', '<name_ar>', '<name_en>', 'DELETE-TEST-DATA-<slug>');
CREATE OR REPLACE FUNCTION public.convert_org_to_production(p_org uuid, p_slug text, p_name_ar text, p_name_en text,
                                                            p_confirm text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o          public.organizations;
  v_slug     text := lower(btrim(coalesce(p_slug, '')));
  v_name_ar  text := btrim(coalesce(p_name_ar, ''));
  v_name_en  text := nullif(btrim(coalesce(p_name_en, '')), '');
  v_block    text[];
  v_g        text;
  v_t        text;
  v_sql      text := '';
  v_sel      text := '';
  v_deleted  jsonb;
  v_total    bigint;
  v_members  int;
  v_counters int;
  v_usage    int;
  v_mock     int;
  v_storage  jsonb;
  v_daftra   jsonb;
  v_noacc    jsonb;
  v_deploy   jsonb;
  v_summary  jsonb;
  v_prev_bl  text := coalesce(current_setting('marsa.g3_bl_batch', true), '');
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'sql_editor_only');
  END IF;
  PERFORM set_config('lock_timeout', '15s', true);
  SELECT * INTO o FROM public.organizations x WHERE x.id = p_org FOR UPDATE;
  IF o.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'organization'); END IF;
  IF o.environment = 'production' OR app.deploy_environment() = 'production'
     OR EXISTS (SELECT 1 FROM app.org_conversions c WHERE c.org_id = p_org) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'already_production');
  END IF;
  -- input
  IF v_slug !~ '^[a-z0-9-]{3,40}$' OR v_slug !~ '^[a-z0-9]' THEN PERFORM app.fail('MRS_INVALID', 'slug'); END IF;
  IF v_slug = 'blue-sea' THEN PERFORM app.fail('MRS_INVALID', 'slug_demo'); END IF;
  IF EXISTS (SELECT 1 FROM public.organizations x WHERE x.slug = v_slug AND x.id <> p_org) THEN
    PERFORM app.fail('MRS_INVALID', 'slug_taken');
  END IF;
  IF p_confirm IS DISTINCT FROM 'DELETE-TEST-DATA-' || v_slug THEN PERFORM app.fail('MRS_INVALID', 'confirm'); END IF;
  IF char_length(v_name_ar) NOT BETWEEN 2 AND 160 OR v_name_ar ~ 'تجريبي|اختبار' THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
  IF char_length(coalesce(v_name_en, '')) > 160 OR coalesce(v_name_en, '') ~* '\m(staging|demo|test)\M' THEN
    PERFORM app.fail('MRS_INVALID', 'name_en');
  END IF;
  v_block := app.convert_check(p_org);
  IF cardinality(v_block) > 0 THEN PERFORM app.fail('MRS_FORBIDDEN', array_to_string(v_block, ' ')); END IF;

  v_storage := app.convert_storage_objects(p_org);
  -- D1: recorded before the delete (the summary keeps the list the owner cleared in Daftra)
  v_daftra := app.convert_daftra_pushed(p_org);

  -- mock channels cannot be deleted (trg_no_delete): switched off
  UPDATE public.msg_channels c SET ingest_enabled = false, send_enabled = false, status = 'disabled'
   WHERE c.org_id = p_org AND c.mode = 'mock' AND (c.ingest_enabled OR c.send_enabled OR c.status <> 'disabled');
  GET DIAGNOSTICS v_mock = ROW_COUNT;

  -- the documented bypass: the deleted tables' append-only / no-delete guards, for the one statement below only
  FOREACH v_g IN ARRAY app.convert_delete_guards() LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', split_part(v_g, ':', 1), split_part(v_g, ':', 2));
  END LOOP;
  -- the B/L mirror (app.sync_tx_bl) has nothing to mirror into deleted transactions
  PERFORM set_config('marsa.g3_bl_batch', 'on', true);

  -- ONE statement: every deleted table at once (FK checks / cascades run at its end, cycles do not matter)
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

  -- memberships: only the platform admins' 'admin' membership stays
  DELETE FROM public.memberships m
   WHERE m.org_id = p_org
     AND NOT (m.role = 'admin' AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = m.user_id));
  GET DIAGNOSTICS v_members = ROW_COUNT;
  v_noacc := app.convert_accounts_without_access(p_org);

  -- references start again at …-000001 (MRS- / REQ- / MSG- / IMP-); usage counters recounted from the empty tables
  DELETE FROM public.org_counters c WHERE c.org_id = p_org;
  GET DIAGNOSTICS v_counters = ROW_COUNT;
  DELETE FROM public.org_usage_counters u WHERE u.org_id = p_org;
  GET DIAGNOSTICS v_usage = ROW_COUNT;
  PERFORM app.g7_recount(p_org);

  -- the org: new name / slug, production, no staging / demo markers (environment is immutable for API callers only)
  UPDATE public.organizations x
     SET slug = v_slug, name_ar = v_name_ar, name_en = v_name_en, environment = 'production',
         settings = x.settings - ARRAY['staging', 'demo', 'note']
   WHERE x.id = p_org;

  SELECT sum(value::bigint) INTO v_total FROM jsonb_each_text(v_deleted);
  v_summary := jsonb_build_object(
    'org_id', p_org, 'from_slug', o.slug, 'slug', v_slug, 'name_ar', v_name_ar, 'name_en', v_name_en,
    'environment', 'production',
    'deleted', v_deleted || jsonb_build_object('memberships', v_members),
    'deleted_total', v_total + v_members,
    'reset', jsonb_build_object('org_counters', v_counters, 'org_usage_counters', v_usage),
    'mock_channels_disabled', v_mock,
    'guards_bypassed', cardinality(app.convert_delete_guards()),
    'kept', jsonb_build_object(
      'branches',    (SELECT count(*) FROM public.branches b WHERE b.org_id = p_org),
      'memberships', (SELECT count(*) FROM public.memberships m WHERE m.org_id = p_org),
      'msg_channels', (SELECT count(*) FROM public.msg_channels c WHERE c.org_id = p_org),
      'daftra_connections', (SELECT count(*) FROM public.daftra_connections d WHERE d.org_id = p_org),
      'audit_log',   (SELECT count(*) FROM public.audit_log a WHERE a.org_id = p_org),
      'ai_usage',    (SELECT count(*) FROM app.ai_usage u WHERE u.org_id = p_org)),
    'storage_objects_left', v_storage,
    'daftra_cleared', v_daftra - 'connection',
    'accounts_without_access', v_noacc);

  INSERT INTO app.org_conversions (org_id, from_slug, to_slug, converted_by, summary)
  VALUES (p_org, o.slug, v_slug, left(session_user::text, 63), v_summary);

  -- the deployment switch (20261112000100, unchanged guards: no demo org, no staging org left)
  v_deploy := public.set_deploy_environment('production');
  PERFORM set_config('marsa.convert_daftra_ack', '', false);
  RETURN v_summary || jsonb_build_object('deploy', v_deploy, 'health_check', public.health_check());
END $$;

-- ---------------------------------------------------------------------
-- 4. privileges: SQL Editor (postgres) only — no API role, not even the Edge Functions' service_role
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_keep_tables(), app.convert_delete_guards(),
  app.convert_check(uuid), app.convert_storage_objects(uuid), app.convert_daftra_pushed(uuid),
  app.convert_accounts_without_access(uuid), app.tg_org_conversions_guard()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.convert_org_preview(uuid),
  public.convert_org_to_production(uuid, text, text, text, text)
FROM PUBLIC, anon, authenticated, service_role;
