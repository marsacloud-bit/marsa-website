-- =====================================================================
-- 20261205000100_service_item_price — the customs clearance line of the opening draft invoice at a set price
-- (2026-11-20, owner stage 3ب, docs/owner/transaction-stages-request.md; branch owner/ui-reorg)
--   Owner: when the preliminary declaration is approved, the draft invoice opened in the accounting program carries ONE
--   line, customs clearance with VAT, 500 SAR, which the employee may change. Until now that opening line was sent at 0
--   (legacy zero line; 20261123000100). The price is now a SETTING of the org's service catalogue, not a value in code:
--   1. public.org_service_items.default_price numeric(12,2) NULL (0 … 1 000 000; NULL = no default price). The table keeps
--      its RLS (staff read; accounts managers / admins insert / update; no DELETE), audit and guards (20261117000100).
--   2. customs_clearance gets 500 for every existing org where it is still NULL; a new org gets it through
--      app.tg_org_service_items_before (re-created: the template row customs_clearance inserted without a price → 500).
--      The org changes it any time (organisation settings → «رسوم التخليص الافتراضية»).
--   3. app.opening_unit_price(org, item_key): the default price of an 'item:<code>' key of the org's catalogue, else 0.
--      Not tied to Daftra: any accounting connector reads the same catalogue price.
--   4. app.bill_job_context (20261123000100 body, re-created): intent.opening_line.unit_price = app.opening_unit_price(…)
--      instead of 0 (the worker already sends the context value; no worker change). VAT unchanged (the connection's
--      default service rate, 15). The employee edits the amount in the draft in the accounting program; Marsa never
--      updates an existing draft (allow_draft_update stays as set).
--   5. public.test_daftra_custom_fields (20261123000100 body, re-created): the dry run shows the same price.
--   6. app.bill_opening_total(intent, snapshot): the opening line's total (net + VAT). The opening line is sent from the job
--      context and is NOT a billing_intent_line, so the totals checks that compare the accounting program's total with the
--      synced lines must add it, or a 500 SAR opening draft would raise a false mismatch:
--   7. app.bill_apply_push_ok (20261123000100 body, re-created): the read-back of a created draft expects lines + the opening
--      line Marsa sent (catalogue price × (1 + service VAT)) — no false readback_mismatch 'total'.
--   8. app.bill_mark_issued (20261123000100 body, re-created): the HF5 issued check (official total = synced lines) adds the
--      opening line as the issued invoice shows it (snapshot: the first unmarked line of the opening product, the amount the
--      employee may have changed; no snapshot lines → the catalogue line) — no false issued_mismatch at issue time.
--   CREATE OR REPLACE keeps each re-created function's privileges.
--   Re-runnable (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD / CREATE OR REPLACE / UPDATE … WHERE NULL).
--   Data: sets default_price = 500 on the customs_clearance item of every existing org (only where it is NULL).
--   Re-pasting 20261123000100 after this file brings back the zero opening line: re-paste this file straight after.
--   Down-path: re-create app.bill_job_context, public.test_daftra_custom_fields, app.bill_apply_push_ok, app.bill_mark_issued
--   (20261123000100) and app.tg_org_service_items_before (20261117000100) verbatim;
--   DROP FUNCTION app.bill_opening_total(public.billing_intents, jsonb); DROP FUNCTION app.opening_unit_price(uuid, text);
--   ALTER TABLE public.org_service_items DROP COLUMN default_price; DELETE FROM public.schema_versions WHERE version = '20261205000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261204000100') THEN
    RAISE EXCEPTION 'SERVICE ITEM PRICE preflight: apply tx_stage_sets first (schema_versions lacks 20261204000100)';
  END IF;
  IF to_regclass('public.org_service_items') IS NULL OR to_regprocedure('app.bill_job_context(public.billing_sync_jobs,uuid,text)') IS NULL
     OR to_regprocedure('public.test_daftra_custom_fields(uuid)') IS NULL OR to_regprocedure('app.tg_org_service_items_before()') IS NULL
     OR to_regprocedure('app.bill_mark_issued(public.billing_intents,jsonb)') IS NULL
     OR to_regprocedure('app.bill_apply_push_ok(public.billing_intents,jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE ITEM PRICE preflight: org_service_items (20261117000100) or bill_job_context / test_daftra_custom_fields (20261123000100) missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261205000100', 'service_item_price')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the default price of a service item
-- ---------------------------------------------------------------------
ALTER TABLE public.org_service_items ADD COLUMN IF NOT EXISTS default_price numeric(12,2);
ALTER TABLE public.org_service_items DROP CONSTRAINT IF EXISTS org_service_items_default_price_check;
ALTER TABLE public.org_service_items ADD CONSTRAINT org_service_items_default_price_check
  CHECK (default_price IS NULL OR (default_price >= 0 AND default_price <= 1000000));
COMMENT ON COLUMN public.org_service_items.default_price IS 'Default price in SAR before VAT (20261205000100); NULL = none. customs_clearance = the opening draft invoice line (500 by default).';

-- ---------------------------------------------------------------------
-- 2. customs clearance 500 SAR: existing orgs now, new orgs on seeding
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_org_service_items_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.name_ar := btrim(NEW.name_ar);
  NEW.name_en := nullif(btrim(coalesce(NEW.name_en, '')), '');
  IF NEW.fin_service IS NOT NULL AND NOT app.is_code('fin_service', NEW.fin_service) THEN
    PERFORM app.fail('MRS_INVALID', 'fin_service');
  END IF;
  -- 20261205000100: the template's customs clearance item starts at 500 SAR (a setting the org changes afterwards)
  IF TG_OP = 'INSERT' AND NEW.code = 'customs_clearance' AND NEW.source = 'template' AND NEW.default_price IS NULL THEN
    NEW.default_price := 500;
  END IF;
  RETURN NEW;
END $$;

UPDATE public.org_service_items s SET default_price = 500
 WHERE s.code = 'customs_clearance' AND s.default_price IS NULL;

-- ---------------------------------------------------------------------
-- 3. the price of an opening line: the catalogue's default price of 'item:<code>', else 0
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.opening_unit_price(p_org uuid, p_item text) RETURNS numeric
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce((SELECT s.default_price FROM public.org_service_items s
                    WHERE s.org_id = p_org AND s.is_active AND p_item LIKE 'item:%' AND s.code = substr(p_item, 6)), 0)::numeric
$$;
REVOKE ALL ON FUNCTION app.opening_unit_price(uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. the job context: the opening line at the catalogue price (20261123000100 body; only the opening line changed)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bill_job_context(j public.billing_sync_jobs, p_attempt uuid, p_prev text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ctx jsonb; v_conn jsonb := app.bill_conn_json(j.org_id); v_l public.daftra_client_links; v_it public.daftra_item_links;
        v_i public.billing_intents; v_t public.transactions; v_items jsonb := '[]'::jsonb; k text; v_r public.daftra_runs;
        v_p public.daftra_purchase_drafts; v_cl public.clients; v_open jsonb; v_sl public.daftra_supplier_links; v_keys jsonb;
        v_trip public.transport_trips; v_pdesc text;
BEGIN
  v_ctx := jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'org_id', j.org_id, 'kind', j.kind, 'attempt_no', j.attempts, 'options', j.options,
                              'expected_hash', j.expected_hash, 'previous_status', p_prev),
    'attempt_id', p_attempt,
    'connection', jsonb_build_object('mode', v_conn ->> 'mode', 'status', v_conn ->> 'status', 'subdomain', v_conn -> 'subdomain',
                                     'capabilities', v_conn -> 'capabilities',
                                     'settings', jsonb_build_object('default_service_vat_rate', v_conn -> 'default_service_vat_rate',
                                                                    'allowed_vat_rates', v_conn -> 'allowed_vat_rates',
                                                                    'reimbursable_tax_code', v_conn -> 'reimbursable_tax_code',
                                                                    'invoice_notes', v_conn -> 'invoice_notes'),
                                     -- L7: what the worker must enforce before any write (and the request guard in daftra-live.js)
                                     'policy', jsonb_build_object('allow_draft_update', coalesce((v_conn ->> 'allow_draft_update')::boolean, false),
                                                                  'allow_product_create', coalesce((v_conn ->> 'allow_product_create')::boolean, false),
                                                                  'products', CASE WHEN coalesce((v_conn ->> 'allow_product_create')::boolean, false)
                                                                                   THEN 'create_missing' ELSE 'resolve_only' END),
                                     'account', v_conn -> 'account_check',
                                     'custom_field_map', coalesce(v_conn -> 'custom_field_map', '{}'::jsonb),
                                     'today', to_char(app.rpt_today(), 'YYYY-MM-DD'), 'time_zone', 'Asia/Riyadh'));
  IF j.client_link_id IS NOT NULL THEN
    SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.id = j.client_link_id;
    v_ctx := v_ctx || jsonb_build_object('client', app.bill_ctx_client(v_l));
  ELSIF j.item_link_id IS NOT NULL THEN
    SELECT * INTO v_it FROM public.daftra_item_links i WHERE i.id = j.item_link_id;
    v_ctx := v_ctx || jsonb_build_object('item', app.bill_ctx_item(v_it));
  ELSIF j.intent_id IS NOT NULL THEN
    SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = j.intent_id;
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = v_i.transaction_id;
    SELECT * INTO v_cl FROM public.clients c WHERE c.id = v_i.client_id;
    v_l := app.bill_ensure_client_link(v_i.org_id, v_i.client_id);
    FOR k IN SELECT DISTINCT l.item_key FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed'
             UNION SELECT v_conn ->> 'opening_item' WHERE v_i.origin = 'opening' ORDER BY 1 LOOP
      v_items := v_items || jsonb_build_array(app.bill_ctx_item(app.bill_ensure_item(v_i.org_id, k)));
    END LOOP;
    IF v_i.origin = 'opening' THEN                                                                                   -- L7
      -- 20261205000100: the opening line's price = the service item's default price (customs clearance 500 SAR by default)
      v_open := jsonb_build_object('item_key', v_conn ->> 'opening_item', 'description', '', 'quantity', 1,
                                   'unit_price', app.opening_unit_price(v_i.org_id, v_conn ->> 'opening_item'),
                                   'vat_rate', coalesce((v_conn ->> 'default_service_vat_rate')::numeric, 15));
    END IF;
    v_ctx := v_ctx || jsonb_build_object('intent', jsonb_build_object(
      'id', v_i.id, 'transaction_id', v_i.transaction_id, 'transaction_ref', v_t.ref, 'operational_ref', v_i.operational_ref,
      'currency', v_i.currency, 'purpose', v_i.purpose, 'status', v_i.status, 'sync_state', v_i.sync_state,
      'external_invoice_id', v_i.external_invoice_id, 'pushed_hash', v_i.pushed_hash, 'remote_version', v_i.remote_version,
      'invoice_date', to_char(coalesce(v_i.invoice_date, app.rpt_today()), 'YYYY-MM-DD'), 'notes', v_conn -> 'invoice_notes',   -- L7: Riyadh
      'origin', v_i.origin, 'po_number', v_i.operational_ref, 'daftra_url', v_i.daftra_url,                              -- L7
      'custom_fields', app.daftra_custom_fields(v_i.transaction_id), 'opening_line', v_open,
      'client', app.bill_ctx_client(v_l) || jsonb_build_object('active', coalesce(v_cl.is_active, false)), 'items', v_items,
      'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('line_id', l.id, 'line_ref', l.line_ref, 'state', l.state, 'pushed', l.pushed,
                                                             'remote_line_id', l.remote_line_id, 'item_key', l.item_key, 'description', l.description,
                                                             'quantity', l.quantity, 'unit_price', l.unit_price, 'vat_rate', l.vat_rate,
                                                             'net_amount', l.net_amount, 'vat_amount', l.vat_amount, 'total_amount', l.total_amount,
                                                             'daftra_description', l.daftra_description, 'manual_in_daftra', l.manual_in_daftra)   -- L7
                                          ORDER BY l.line_ref)
                           FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed'), '[]'::jsonb)));
  ELSIF j.run_id IS NOT NULL THEN                                                                                     -- L7
    SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = j.run_id;
    v_ctx := v_ctx || jsonb_build_object('run', jsonb_build_object('id', v_r.id, 'kind', v_r.kind, 'params', v_r.params,
      'cursor', coalesce(v_r.cursor, '{}'::jsonb), 'pages_done', v_r.pages,
      'page_size', coalesce((v_r.params ->> 'page_size')::int, 100), 'pages_per_job', coalesce((v_r.params ->> 'pages_per_job')::int, 5)));
    IF v_r.kind = 'product_match' THEN
      v_ctx := v_ctx || jsonb_build_object('products', coalesce((
        SELECT jsonb_agg(jsonb_build_object('item_key', i.item_key, 'link_id', i.id, 'remote_product_code', i.remote_product_code,
                                            'remote_code_norm', i.remote_code_norm, 'name_ar', i.name_ar) ORDER BY i.item_key)
          FROM public.daftra_item_links i
         WHERE i.org_id = j.org_id AND i.status <> 'retired'
           AND (jsonb_typeof(v_r.params -> 'item_keys') IS DISTINCT FROM 'array' OR v_r.params -> 'item_keys' ? i.item_key)), '[]'::jsonb));
    END IF;
  ELSIF j.transaction_id IS NOT NULL THEN                                                                             -- L7: invoice_lookup
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = j.transaction_id;
    SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.org_id = v_t.org_id AND l.client_id = v_t.client_id AND l.status <> 'unlinked';
    v_keys := app.daftra_tx_keys(v_t.id);
    v_ctx := v_ctx || jsonb_build_object('transaction', jsonb_build_object('id', v_t.id, 'ref', v_t.ref,
      'client_external_id', CASE WHEN v_l.status IN ('linked','drift') THEN v_l.external_id END,
      'declaration_nos', v_keys -> 'declaration_nos', 'bl_numbers', v_keys -> 'bl_numbers', 'containers', v_keys -> 'containers',
      'cargo_unit_type', v_keys -> 'cargo_unit_type'),
      'lookup', jsonb_build_object('mode', j.options ->> 'mode', 'number', j.options ->> 'number'));
  ELSIF j.purchase_id IS NOT NULL THEN                                                                                -- L7: purchase_push
    SELECT * INTO v_p FROM public.daftra_purchase_drafts p WHERE p.id = j.purchase_id;
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = v_p.transaction_id;
    SELECT * INTO v_sl FROM public.daftra_supplier_links s WHERE s.id = v_p.supplier_link_id;
    SELECT * INTO v_it FROM public.daftra_item_links i WHERE i.org_id = v_p.org_id AND i.item_key = v_p.item_key AND i.status <> 'retired';
    -- review: the legacy line description (ensureMovementPurchaseDraftR12_): transaction | client | declaration | container |
    -- driver | appointment (TAS), the parts that exist, ≤ 900 characters
    SELECT * INTO v_trip FROM public.transport_trips r WHERE r.id = v_p.trip_id;
    v_pdesc := left(concat_ws(' | ',
      'المعاملة: ' || v_t.ref,
      'العميل: ' || (SELECT c.name_ar FROM public.clients c WHERE c.id = v_t.client_id),
      'البيان: ' || (SELECT d.declaration_no FROM public.customs_declarations d WHERE d.transaction_id = v_t.id AND d.status NOT IN ('cancelled','replaced')
                      ORDER BY d.created_at DESC, d.id DESC LIMIT 1),
      'الحاوية: ' || (SELECT k.container_no FROM public.containers k WHERE k.id = v_trip.container_id),
      'السائق: ' || (SELECT dr.full_name FROM public.drivers dr WHERE dr.id = v_trip.driver_id),
      'الموعد: ' || (SELECT app.norm_tas(pa.appointment_no) FROM public.port_appointments pa WHERE pa.id = v_trip.appointment_id)), 900);
    v_ctx := v_ctx || jsonb_build_object('purchase', jsonb_build_object('id', v_p.id, 'reference', v_p.reference, 'trip_id', v_p.trip_id,
      'transaction_id', v_p.transaction_id, 'transaction_ref', v_t.ref, 'supplier_external_id', v_sl.external_supplier_id,
      'supplier_name', v_sl.name, 'external_purchase_id', v_p.external_purchase_id, 'status', v_p.status,
      'invoice_date', to_char(coalesce(v_p.invoice_date, app.rpt_today()), 'YYYY-MM-DD'),
      'item', CASE WHEN v_it.id IS NOT NULL THEN app.bill_ctx_item(v_it) END,
      'lines', jsonb_build_array(jsonb_build_object('item_key', v_p.item_key, 'description', coalesce(nullif(v_pdesc, ''), v_t.ref), 'quantity', 1,
                                                    'unit_price', v_p.amount, 'vat_rate', 0)),
      'amount', v_p.amount, 'currency', v_p.currency, 'tax', 0));
  END IF;
  RETURN v_ctx;
END $$;

-- ---------------------------------------------------------------------
-- 5. the dry run shows the same opening price (20261123000100 body; only the opening line changed)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.test_daftra_custom_fields(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_conn public.daftra_connections; v_l public.daftra_client_links; v_cf jsonb; v_un text[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_t FROM public.transactions t WHERE t.id = p_tx;
  IF v_t.id IS NULL OR NOT app.has_tx_role(v_t.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.daftra_is_owner(v_t.org_id) THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner_only'); END IF;
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_t.org_id;
  SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.org_id = v_t.org_id AND l.client_id = v_t.client_id AND l.status <> 'unlinked';
  v_cf := app.daftra_custom_fields(v_t.id);
  v_un := app.daftra_unmapped(v_t.org_id, ARRAY[coalesce(v_conn.opening_item, 'item:customs_clearance')]);
  RETURN jsonb_build_object('transaction_id', v_t.id, 'ref', v_t.ref, 'would_send', false, 'dry_run', true,
    'payload', jsonb_build_object('invoice_date', to_char(app.rpt_today(), 'YYYY-MM-DD'), 'time_zone', 'Asia/Riyadh',
      'po_number', v_t.ref, 'draft', 1, 'client_external_id', CASE WHEN v_l.status IN ('linked','drift') THEN v_l.external_id END,
      'opening_line', jsonb_build_object('item_key', coalesce(v_conn.opening_item, 'item:customs_clearance'),
        'remote_product_code', (SELECT i.remote_product_code FROM public.daftra_item_links i WHERE i.org_id = v_t.org_id
                                  AND i.item_key = coalesce(v_conn.opening_item, 'item:customs_clearance') AND i.status <> 'retired'),
        'description', '', 'quantity', 1,
        'unit_price', app.opening_unit_price(v_t.org_id, coalesce(v_conn.opening_item, 'item:customs_clearance'))),   -- 20261205000100
      'custom_fields', v_cf -> 'payload'),
    'fields', v_cf -> 'fields', 'values', app.daftra_custom_values(v_t.id), 'missing', v_cf -> 'missing',
    'unmapped', to_jsonb(v_un), 'client_linked', v_l.status IN ('linked','drift') AND v_l.external_id IS NOT NULL,
    'account_check', CASE WHEN v_conn.id IS NOT NULL THEN app.daftra_account_check(v_conn) END,
    'ok', jsonb_array_length(v_cf -> 'missing') = 0 AND cardinality(v_un) = 0);
END $$;

-- ---------------------------------------------------------------------
-- 6. the opening line's total (net + VAT) for the totals checks: the opening line is sent from the job context, it is not
--    a billing_intent_line, so the read-back (bill_apply_push_ok) and the HF5 issued check (bill_mark_issued) add it
--    p_snap NULL / without lines → what Marsa sends (the catalogue price, the connection's service VAT rate);
--    p_snap.lines → the line as the accounting program shows it; none → 0. The opening line is an unmarked (no [MRSL-])
--    line whose product is the opening item's live product, else a product that item was ever linked to, else no product
--    (pushed without a link); among those the earliest created one (lowest numeric Daftra line id; the snapshot sorts
--    foreign lines by their JSON, not by invoice order), so a line the accountant adds later by hand — another product, or
--    the same product again — is not taken for it
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bill_opening_total(p_i public.billing_intents, p_snap jsonb) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_conn jsonb; v_key text; v_rate numeric; v_pid text; v_pids text[]; x jsonb; v_q numeric; v_p numeric; v_net numeric;
        c_num constant text := '^-?[0-9]{1,12}(\.[0-9]{1,6})?$';
BEGIN
  IF p_i.id IS NULL OR p_i.origin IS DISTINCT FROM 'opening' THEN RETURN 0; END IF;
  v_conn := app.bill_conn_json(p_i.org_id);
  v_key := coalesce(v_conn ->> 'opening_item', 'item:customs_clearance');
  v_rate := coalesce(CASE WHEN (v_conn ->> 'default_service_vat_rate') ~ c_num THEN (v_conn ->> 'default_service_vat_rate')::numeric END, 15);
  IF jsonb_typeof(p_snap -> 'lines') = 'array' THEN
    SELECT i.external_product_id INTO v_pid FROM public.daftra_item_links i
     WHERE i.org_id = p_i.org_id AND i.item_key = v_key AND i.status <> 'retired';
    SELECT coalesce(array_agg(i.external_product_id) FILTER (WHERE i.external_product_id IS NOT NULL), ARRAY[]::text[]) INTO v_pids
      FROM public.daftra_item_links i WHERE i.org_id = p_i.org_id AND i.item_key = v_key;
    SELECT e.v INTO x FROM jsonb_array_elements(p_snap -> 'lines') WITH ORDINALITY e(v, n)
     WHERE jsonb_typeof(e.v) = 'object' AND nullif(e.v ->> 'line_ref', '') IS NULL
       AND (nullif(e.v ->> 'product_id', '') IS NULL OR e.v ->> 'product_id' = ANY (v_pids))
     ORDER BY CASE WHEN v_pid IS NOT NULL AND e.v ->> 'product_id' = v_pid THEN 0
                   WHEN nullif(e.v ->> 'product_id', '') IS NOT NULL THEN 1 ELSE 2 END,
              CASE WHEN (e.v ->> 'id') ~ '^[0-9]{1,18}$' THEN (e.v ->> 'id')::numeric END NULLS LAST, e.n
     LIMIT 1;
    IF x IS NULL THEN RETURN 0; END IF;
    v_q := CASE WHEN (x ->> 'quantity') ~ c_num THEN (x ->> 'quantity')::numeric ELSE 1 END;
    v_p := CASE WHEN (x ->> 'unit_price') ~ c_num THEN (x ->> 'unit_price')::numeric ELSE 0 END;
    IF (x ->> 'tax_rate') ~ c_num THEN v_rate := (x ->> 'tax_rate')::numeric; END IF;
  ELSE
    v_q := 1;
    v_p := app.opening_unit_price(p_i.org_id, v_key);
  END IF;
  v_net := round(v_q * v_p, 2);
  RETURN v_net + round(v_net * v_rate / 100, 2);
END $$;
REVOKE ALL ON FUNCTION app.bill_opening_total(public.billing_intents, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. the read-back of a created draft expects the opening line too (20261123000100 body; only the expected total changed)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bill_apply_push_ok(p_i public.billing_intents, p_eff jsonb, p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_ext text; v_state text; v_by text; v_ph text; v_rh text; v_tot numeric[]; v_url text;
        v_rb jsonb; v_rbd date; v_rbc text; v_rbt numeric; v_link text; v_diff text[] := '{}'; v_exp numeric;
BEGIN
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_invoice_id', 64), 'external_invoice_id');
  IF v_ext IS NULL THEN PERFORM app.fail('MRS_INVALID', 'external_invoice_id'); END IF;
  IF p_i.external_invoice_id IS NOT NULL AND p_i.external_invoice_id <> v_ext THEN PERFORM app.fail('MRS_INVALID', 'external_invoice_id'); END IF;
  PERFORM app.bill_check_invoice_free(p_i.org_id, p_i.id, v_ext);
  v_state := coalesce(app.bill_rtext(p_eff, 'remote_state', 20), 'draft');
  IF v_state NOT IN ('draft','issued','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'remote_state'); END IF;
  IF v_state <> 'draft' THEN
    -- the read-back is no longer a draft: frozen (handled as a pull)
    PERFORM app.bill_apply_pull(p_i, p_eff || jsonb_build_object('external_invoice_id', v_ext));
    RETURN;
  END IF;
  v_by := app.bill_rtext(p_eff, 'found_by', 20);
  IF v_by IS NULL OR v_by NOT IN ('ref','created','existing') THEN PERFORM app.fail('MRS_INVALID', 'found_by'); END IF;
  v_ph := app.bill_hash(app.bill_rtext(p_eff, 'pushed_hash', 64), 'pushed_hash');
  IF v_ph IS NULL THEN PERFORM app.fail('MRS_INVALID', 'pushed_hash'); END IF;
  v_rh := app.bill_hash(app.bill_rtext(p_eff, 'remote_hash', 64), 'remote_hash');
  v_tot := app.bill_totals(p_eff -> 'remote_totals');
  v_url := app.bill_rtext(p_eff, 'daftra_url', 500);                                                                 -- L7
  IF v_url IS NOT NULL AND v_url !~ '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9_./?=&%-]*)?$' THEN PERFORM app.fail('MRS_INVALID', 'daftra_url'); END IF;
  v_rb := p_eff -> 'read_back';
  IF v_rb IS NOT NULL AND jsonb_typeof(v_rb) NOT IN ('object','null') THEN PERFORM app.fail('MRS_INVALID', 'read_back'); END IF;
  UPDATE public.billing_intents i SET external_invoice_id = v_ext, status = CASE WHEN i.status = 'open' THEN 'draft' ELSE i.status END,
         daftra_number = coalesce(app.bill_rtext(p_eff, 'daftra_number', 60), i.daftra_number),
         daftra_status = coalesce(app.bill_rtext(p_eff, 'daftra_status', 40), i.daftra_status),
         remote_version = coalesce(app.bill_rtext(p_eff, 'remote_version', 64), i.remote_version),
         pushed_hash = v_ph, remote_hash = coalesce(v_rh, v_ph), pushed_at = now(), last_synced_at = now(),
         remote_net = coalesce(v_tot[1], i.remote_net), remote_vat = coalesce(v_tot[2], i.remote_vat), remote_total = coalesce(v_tot[3], i.remote_total),
         daftra_url = coalesce(v_url, i.daftra_url),                                                                   -- L7
         conflict = NULL, last_error_code = NULL, last_error_message = NULL
   WHERE i.id = p_i.id RETURNING * INTO v_i;
  PERFORM app.bill_line_results(v_i, p_eff -> 'line_results');
  UPDATE public.billing_intents i SET sync_state = CASE WHEN app.bill_has_pending(i.id) THEN 'pending' ELSE 'synced' END
   WHERE i.id = p_i.id;
  -- L7: the read-back of the draft just created (legacy assertDaftraInvoiceDateSafe_): date / client / total
  IF jsonb_typeof(v_rb) = 'object' THEN
    BEGIN v_rbd := app.bill_rtext(v_rb, 'date', 10)::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN PERFORM app.fail('MRS_INVALID', 'read_back'); END;
    v_rbc := app.bill_ext_id(app.bill_rtext(v_rb, 'client_id', 64), 'read_back');
    v_rbt := app.fin_money(v_rb, 'total');
    -- review (legacy assertDaftraInvoiceDateSafe_): a created draft whose stored date cannot be read is a date_mismatch too
    IF v_i.invoice_date IS NOT NULL AND (v_rbd IS DISTINCT FROM v_i.invoice_date) AND (v_rbd IS NOT NULL OR v_by = 'created') THEN
      PERFORM app.daftra_review_open(v_i.org_id, v_i.transaction_id, v_i.id, 'date_mismatch',
        jsonb_build_object('expected', v_i.invoice_date, 'stored', v_rbd, 'time_zone', 'Asia/Riyadh', 'daftra_number', v_i.daftra_number));
    END IF;
    SELECT l.external_id INTO v_link FROM public.daftra_client_links l
     WHERE l.org_id = v_i.org_id AND l.client_id = v_i.client_id AND l.status IN ('linked','drift');
    IF v_rbc IS NOT NULL AND v_link IS NOT NULL AND v_rbc <> v_link THEN v_diff := v_diff || 'client'::text; END IF;
    SELECT coalesce(sum(l.total_amount), 0) INTO v_exp FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state = 'synced';
    v_exp := v_exp + app.bill_opening_total(v_i, NULL);                                -- 20261205000100: + the opening line sent
    IF v_rbt IS NOT NULL AND v_by = 'created' AND v_rbt <> v_exp THEN v_diff := v_diff || 'total'::text; END IF;
    IF (v_rb ->> 'line_count') ~ '^[0-9]{1,4}$' AND v_by = 'created'
       AND (v_rb ->> 'line_count')::int <> (SELECT count(*)::int FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state = 'synced')
                                            + (CASE WHEN v_i.origin = 'opening' THEN 1 ELSE 0 END) THEN
      v_diff := v_diff || 'lines'::text;
    END IF;
    IF cardinality(v_diff) > 0 THEN
      PERFORM app.daftra_review_open(v_i.org_id, v_i.transaction_id, v_i.id, 'readback_mismatch',
        jsonb_build_object('fields', to_jsonb(v_diff), 'expected_total', v_exp, 'stored_total', v_rbt, 'expected_client_id', v_link,
                           'stored_client_id', v_rbc, 'line_count', v_rb -> 'line_count'));
    END IF;
  END IF;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'draft_synced', 'billing_intent', v_i.id,
    jsonb_build_object('job_id', p_job, 'found_by', v_by, 'origin', v_i.origin));
  PERFORM app.bill_tx_financial(v_i.transaction_id);
  PERFORM app.daftra_manual_refresh(v_i.id);                                                                          -- L7
END $$;

-- ---------------------------------------------------------------------
-- 8. the HF5 issued check counts the opening line (20261123000100 body; only the opening total added)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bill_mark_issued(p_i public.billing_intents, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_snap jsonb := p_eff -> 'remote_snapshot'; v_refs text[]; v_inv uuid[] := '{}'; v_late uuid[] := '{}'; v_l public.billing_intent_lines;
        v_hash text := p_eff ->> 'remote_hash'; v_held jsonb; v_det jsonb; v_hf5 boolean := NOT app.daftra_allow_update(p_i.org_id);
        v_tot numeric[] := app.bill_totals(p_eff -> 'remote_totals'); v_lines numeric;
        v_man public.billing_review_items; v_hand uuid[] := '{}'; v_exp numeric; v_as_listed boolean := false;
        v_open numeric := 0;                                                                   -- 20261205000100
BEGIN
  v_refs := ARRAY(SELECT x ->> 'line_ref' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_snap -> 'lines') = 'array' THEN v_snap -> 'lines' ELSE '[]'::jsonb END) x
                   WHERE jsonb_typeof(x) = 'object' AND x ->> 'line_ref' IS NOT NULL);
  -- 20261205000100: the opening line (customs clearance at the catalogue price, no [MRSL-] marker, not a billing line) is on
  -- the issued invoice too: the HF5 totals check counts it (as Daftra shows it: the employee may have changed the amount)
  IF v_hf5 AND p_i.origin = 'opening' THEN v_open := app.bill_opening_total(p_i, v_snap); END IF;
  -- review (HF5): the lines an OPEN manual_in_daftra item asked the accountant to add / remove by hand carry no [MRSL-] marker
  -- on the issued invoice. When the official total equals the synced lines + the listed additions, the hand edit is taken as
  -- done (the additions are invoiced, the removals removed; item resolved 'issued_as_listed'). Otherwise they are HELD: not
  -- removed, no late_charge, the item stays open (details.issued) and a human decides (done_in_daftra → invoiced; dismiss →
  -- not billed: removed + late_charge); the totals mismatch item is raised as before.
  IF v_hf5 AND p_i.origin <> 'linked' THEN
    SELECT * INTO v_man FROM public.billing_review_items r WHERE r.intent_id = p_i.id AND r.kind = 'manual_in_daftra' AND r.status = 'open' FOR UPDATE;
    IF v_man.id IS NOT NULL THEN
      v_hand := ARRAY(SELECT (x ->> 'line_id')::uuid FROM jsonb_array_elements(coalesce(v_man.details -> 'add', '[]'::jsonb) || coalesce(v_man.details -> 'remove', '[]'::jsonb)) x
                       WHERE x ->> 'line_id' ~ '^[0-9a-f-]{36}$');
      SELECT coalesce(sum(l.total_amount) FILTER (WHERE l.state = 'synced' OR (l.state = 'pending_add' AND l.id = ANY (v_hand))), 0) INTO v_exp
        FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND NOT (l.line_ref = ANY (v_refs) AND l.state = 'pending_remove');
      v_as_listed := v_tot[3] IS NOT NULL AND v_tot[3] = v_exp + v_open;                                    -- 20261205000100
    END IF;
  END IF;
  FOR v_l IN SELECT * FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND l.state <> 'removed' ORDER BY l.id FOR UPDATE LOOP
    IF v_l.line_ref = ANY (v_refs) OR (v_l.manual_in_daftra AND v_l.state = 'synced') THEN                         -- L7
      UPDATE public.billing_intent_lines l SET state = 'synced', pushed = true WHERE l.id = v_l.id AND (l.state <> 'synced' OR NOT l.pushed);
      v_inv := v_inv || v_l.charge_id;
    ELSIF v_l.id = ANY (v_hand) AND v_l.state IN ('pending_add','pending_remove') THEN                               -- review
      IF v_as_listed AND v_l.state = 'pending_add' THEN
        UPDATE public.billing_intent_lines l SET state = 'synced', manual_in_daftra = true, pushed = true WHERE l.id = v_l.id;
        v_inv := v_inv || v_l.charge_id;
      ELSIF v_as_listed THEN
        UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(), removed_reason = coalesce(v_l.removed_reason, 'removed_in_daftra')
         WHERE l.id = v_l.id;
      END IF;                                                                     -- else held for the open manual_in_daftra item
    ELSE
      UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(),
             removed_reason = CASE WHEN v_l.state = 'pending_remove' THEN coalesce(v_l.removed_reason, 'not_on_issued') ELSE 'not_on_issued' END
       WHERE l.id = v_l.id;
      IF v_l.state <> 'pending_remove' THEN v_late := v_late || v_l.charge_id; END IF;
    END IF;
  END LOOP;
  PERFORM app.bill_set_charges(v_inv, 'invoiced');
  INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, charge_id, kind, details)
  SELECT p_i.org_id, p_i.transaction_id, p_i.id, c, 'late_charge', jsonb_build_object('reason', 'not_on_issued') FROM unnest(v_late) c
  ON CONFLICT (charge_id, kind) WHERE status = 'open' DO NOTHING;
  -- backstop: a line Marsa already removed locally whose line_ref is on the issued invoice (its charge is held, never
  -- billed twice, until a human resolves the mismatch)
  SELECT coalesce(jsonb_agg(jsonb_build_object('line_ref', l.line_ref, 'line_id', l.id, 'charge_id', l.charge_id) ORDER BY l.line_ref), '[]'::jsonb)
    INTO v_held
    FROM public.billing_intent_lines l
   WHERE l.intent_id = p_i.id AND l.state = 'removed' AND l.line_ref = ANY (v_refs)
     AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines o WHERE o.charge_id = l.charge_id AND o.state <> 'removed');
  SELECT coalesce(sum(l.total_amount), 0) INTO v_lines FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND l.state = 'synced';
  IF (NOT v_hf5 AND p_i.pushed_hash IS NOT NULL AND v_hash IS DISTINCT FROM p_i.pushed_hash)
     OR (v_hf5 AND p_i.origin <> 'linked' AND v_tot[3] IS NOT NULL AND v_tot[3] <> v_lines + v_open)                     -- L7; 20261205000100
     OR jsonb_array_length(v_held) > 0 THEN
    -- the same redaction and bounds as the conflict path (bill_apply_conflict); an oversize snapshot / diff is dropped
    v_det := jsonb_build_object('diff', app.bill_diff_cap(p_eff -> 'diff'), 'pushed_hash', p_i.pushed_hash, 'remote_hash', v_hash,
                                'remote_snapshot', app.bill_redact(CASE WHEN jsonb_typeof(v_snap) = 'object' THEN v_snap END),
                                'removed_on_remote', v_held);
    IF jsonb_array_length(v_held) = 0 THEN v_det := v_det - 'removed_on_remote'; END IF;
    IF v_hf5 THEN v_det := v_det || jsonb_build_object('reason', 'totals', 'remote_total', v_tot[3], 'lines_total', v_lines); END IF;   -- L7
    IF v_hf5 AND v_open <> 0 THEN v_det := v_det || jsonb_build_object('opening_total', v_open); END IF;                 -- 20261205000100
    v_det := app.bill_bound_details(v_det);
    INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
    VALUES (p_i.org_id, p_i.transaction_id, p_i.id, 'issued_mismatch', v_det)
    ON CONFLICT (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL DO NOTHING;
  END IF;
  UPDATE public.billing_intents i SET status = 'issued', issued_at = coalesce(i.issued_at, now()), sync_state = 'synced', conflict = NULL
   WHERE i.id = p_i.id;
  -- L7: nothing is left to change by hand on an issued invoice (Daftra is the truth; late charges are their own items).
  -- review: an item whose listed lines are held stays open (issued: true) for the human decision
  IF v_man.id IS NOT NULL AND NOT v_as_listed AND cardinality(v_hand) > 0
     AND EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.id = ANY (v_hand) AND l.state IN ('pending_add','pending_remove')) THEN
    UPDATE public.billing_review_items r SET details = r.details || jsonb_build_object('issued', true, 'issued_total', v_tot[3], 'expected_total', v_exp)
     WHERE r.id = v_man.id;
  ELSE
    UPDATE public.billing_review_items r SET status = 'resolved', resolution = CASE WHEN v_as_listed THEN 'issued_as_listed' ELSE 'issued' END,
           resolved_at = now()
     WHERE r.intent_id = p_i.id AND r.kind = 'manual_in_daftra' AND r.status = 'open';
  END IF;
  PERFORM app.bill_event(p_i.org_id, p_i.transaction_id, 'issued', 'billing_intent', p_i.id,
    jsonb_build_object('charge_ids', to_jsonb(v_inv), 'late_charge_ids', CASE WHEN cardinality(v_late) > 0 THEN to_jsonb(v_late) END));
END $$;
