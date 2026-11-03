-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261111000100 — G5b: LIVE Daftra connection (API v2, one allowlisted org) next to the
-- G5 mock (docs/online/G5B_DAFTRA_LIVE_AR.md). Builds on G6c (20261110000100).
--
-- NO secret in the database: the Daftra API key lives in Edge Function secrets only (MARSA_DAFTRA_API_KEY, fallback the
-- owner's existing secret "Marsa"); the Edge Function builds the live adapter only for the ONE org in
-- MARSA_DAFTRA_LIVE_ORG whose connection subdomain equals MARSA_DAFTRA_SUBDOMAIN. 'live_pending' is unchanged (every
-- job fails not_configured). Marsa only creates / updates Daftra DRAFTS; it never issues (update_draft/{id}/0), never
-- sends to ETA / ZATCA, never e-mails a client and never records a payment (daftra-live.js request guard).
--   P. preflight (G6c applied) + schema_versions row
--   0. dictionary   daftra_mode 'live'
--   1. constraints  daftra_connections mode IN (mock, live_pending, live); 'live' needs a subdomain
--   2. re-created   (body copied from 20261105000100, changed minimally; no other migration re-creates it)
--                   public.save_daftra_connection + 'live' accepted (same bill_admin gate) and only with a subdomain;
--                                                    + in live mode a subdomain change resets the connection like a mode
--                                                      change (status not_connected, capabilities cleared: a new probe
--                                                      of the new account is required)
--   3. privileges   (re-asserted identically for the re-created function)
-- Unchanged on purpose: daftra_claim_jobs (adapter_mode 'live' for every non-mock mode already), bill_apply_probe
-- (capabilities_source = the adapter mode; a mode change meanwhile makes the result stale), every mock / live_pending path.
-- Adds no table and no column. Re-runnable (CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS / ON CONFLICT).
-- Re-pasting 20261105000100 after this file restores the G5 body (live refused by save_daftra_connection): re-paste this
-- file right after.
-- Down-path: set every live connection back to mode 'mock' (or 'live_pending'), then re-paste the G5 body.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261110000100') THEN
    RAISE EXCEPTION 'G5b preflight: apply G6c first (schema_versions lacks 20261110000100 g6c_live_email)';
  END IF;
  IF to_regclass('public.daftra_connections') IS NULL THEN
    RAISE EXCEPTION 'G5b preflight: public.daftra_connections not found (G5 Daftra schema missing)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.daftra_connections c WHERE c.mode NOT IN ('mock','live_pending','live')) THEN
    RAISE EXCEPTION 'G5b preflight: daftra_connections holds an unknown mode';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261111000100', 'g5b_daftra_live')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionary (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('daftra_mode','live',3,'حساب دفترة حقيقي — مسودات فقط','Live Daftra account (drafts only)',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. constraints
-- ---------------------------------------------------------------------
ALTER TABLE public.daftra_connections DROP CONSTRAINT IF EXISTS daftra_connections_mode_check;
ALTER TABLE public.daftra_connections ADD CONSTRAINT daftra_connections_mode_check CHECK (mode IN ('mock','live_pending','live'));
ALTER TABLE public.daftra_connections DROP CONSTRAINT IF EXISTS daftra_connections_live_sub_chk;
ALTER TABLE public.daftra_connections ADD CONSTRAINT daftra_connections_live_sub_chk CHECK (mode <> 'live' OR subdomain IS NOT NULL);

-- ---------------------------------------------------------------------
-- 2. re-created function (20261105000100 body, minimal G5b changes marked "G5b")
-- ---------------------------------------------------------------------
-- save_daftra_connection(p_org, {mode, subdomain, sync_enabled, default_service_vat_rate, allowed_vat_rates, reimbursable_tax_code, invoice_notes})
CREATE OR REPLACE FUNCTION public.save_daftra_connection(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_connections; v_old public.daftra_connections; v_mode text; v_sub text; v_sync boolean; v_rate numeric;
        v_rates numeric[]; v_tax text; e jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['mode','subdomain','sync_enabled','default_service_vat_rate','allowed_vat_rates',
                                         'reimbursable_tax_code','invoice_notes']);
  INSERT INTO public.daftra_connections (org_id, created_by, updated_by) VALUES (p_org, auth.uid(), auth.uid())
  ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v_old FROM public.daftra_connections c WHERE c.org_id = p_org FOR UPDATE;
  v := v_old;
  IF p_payload ? 'mode' THEN
    v_mode := app.ptext(p_payload, 'mode', 20, true);
    -- G5b: 'live' = the real Daftra adapter (index.ts builds it for the one allowlisted org only)
    IF v_mode NOT IN ('mock','live_pending','live') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
    v.mode := v_mode;
  END IF;
  IF p_payload ? 'subdomain' THEN
    v_sub := lower(app.ptext(p_payload, 'subdomain', 63));
    IF v_sub IS NOT NULL AND v_sub !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' THEN PERFORM app.fail('MRS_INVALID', 'subdomain'); END IF;
    -- one Daftra account per org (the other org is never named)
    IF v_sub IS NOT NULL AND EXISTS (SELECT 1 FROM public.daftra_connections c WHERE lower(c.subdomain) = v_sub AND c.org_id <> p_org) THEN
      PERFORM app.fail('MRS_INVALID', 'subdomain_taken');
    END IF;
    v.subdomain := v_sub;
  END IF;
  -- G5b: a live connection names its account
  IF v.mode = 'live' AND v.subdomain IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'subdomain'); END IF;
  IF p_payload ? 'sync_enabled' THEN
    IF jsonb_typeof(p_payload -> 'sync_enabled') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'sync_enabled'); END IF;
    v.sync_enabled := (p_payload ->> 'sync_enabled')::boolean;
  END IF;
  IF p_payload ? 'default_service_vat_rate' THEN
    IF jsonb_typeof(p_payload -> 'default_service_vat_rate') IN ('object','array','boolean') THEN PERFORM app.fail('MRS_INVALID', 'default_service_vat_rate'); END IF;
    v_rate := app.pnum(p_payload, 'default_service_vat_rate', 100);
    IF v_rate IS NULL OR v_rate <> round(v_rate, 2) THEN PERFORM app.fail('MRS_INVALID', 'default_service_vat_rate'); END IF;
    v.default_service_vat_rate := v_rate;
  END IF;
  IF p_payload ? 'allowed_vat_rates' THEN
    IF jsonb_typeof(p_payload -> 'allowed_vat_rates') <> 'array' OR jsonb_array_length(p_payload -> 'allowed_vat_rates') NOT BETWEEN 1 AND 10 THEN
      PERFORM app.fail('MRS_INVALID', 'allowed_vat_rates');
    END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_payload -> 'allowed_vat_rates') x LOOP
      IF jsonb_typeof(e) NOT IN ('number','string') OR (e #>> '{}') !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (e #>> '{}')::numeric > 100 THEN
        PERFORM app.fail('MRS_INVALID', 'allowed_vat_rates');
      END IF;
    END LOOP;
    SELECT array_agg(DISTINCT (x #>> '{}')::numeric(5,2) ORDER BY (x #>> '{}')::numeric(5,2)) INTO v_rates
      FROM jsonb_array_elements(p_payload -> 'allowed_vat_rates') x;
    v.allowed_vat_rates := v_rates;
  END IF;
  IF NOT (v.default_service_vat_rate = ANY (v.allowed_vat_rates)) THEN PERFORM app.fail('MRS_INVALID', 'default_service_vat_rate'); END IF;
  IF p_payload ? 'reimbursable_tax_code' THEN
    v_tax := app.ptext(p_payload, 'reimbursable_tax_code', 20, true);
    IF NOT app.is_code('daftra_tax_code', v_tax) THEN PERFORM app.fail('MRS_INVALID', 'reimbursable_tax_code'); END IF;
    v.reimbursable_tax_code := v_tax;
  END IF;
  IF p_payload ? 'invoice_notes' THEN v.invoice_notes := app.ptext(p_payload, 'invoice_notes', 500); END IF;
  -- status: a mode change forces a new probe; switching sync off / on toggles connected ⇄ disabled
  -- G5b: in live mode a subdomain change is another account: it forces a new probe too
  IF v.mode IS DISTINCT FROM v_old.mode OR (v.mode = 'live' AND v.subdomain IS DISTINCT FROM v_old.subdomain) THEN
    v.status := 'not_connected'; v.capabilities := '{}'::jsonb; v.capabilities_checked_at := NULL; v.capabilities_source := NULL;
  ELSIF v.sync_enabled IS DISTINCT FROM v_old.sync_enabled THEN
    IF NOT v.sync_enabled AND v_old.status = 'connected' THEN v.status := 'disabled';
    ELSIF v.sync_enabled AND v_old.status = 'disabled' THEN
      v.status := CASE WHEN v_old.last_check_status = 'ok' THEN 'connected' ELSE 'not_connected' END;
    END IF;
  END IF;
  UPDATE public.daftra_connections c SET mode = v.mode, subdomain = v.subdomain, sync_enabled = v.sync_enabled,
         default_service_vat_rate = v.default_service_vat_rate, allowed_vat_rates = v.allowed_vat_rates,
         reimbursable_tax_code = v.reimbursable_tax_code, invoice_notes = v.invoice_notes, status = v.status,
         capabilities = v.capabilities, capabilities_checked_at = v.capabilities_checked_at, capabilities_source = v.capabilities_source,
         updated_by = auth.uid()
   WHERE c.id = v_old.id RETURNING * INTO v;
  RETURN app.bill_conn_json(p_org) || jsonb_build_object('from', v_old.status);
END $$;

-- ---------------------------------------------------------------------
-- 3. privileges (as in 20261105000100: staff RPC → authenticated)
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.save_daftra_connection(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_daftra_connection(uuid, jsonb) TO authenticated;
