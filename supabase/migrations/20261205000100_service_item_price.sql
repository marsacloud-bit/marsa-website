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
--   CREATE OR REPLACE keeps each re-created function's privileges.
--   Re-runnable (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD / CREATE OR REPLACE / UPDATE … WHERE NULL).
--   Data: sets default_price = 500 on the customs_clearance item of every existing org (only where it is NULL).
--   Re-pasting 20261123000100 after this file brings back the zero opening line: re-paste this file straight after.
--   Down-path: re-create app.bill_job_context, public.test_daftra_custom_fields (20261123000100) and
--   app.tg_org_service_items_before (20261117000100) verbatim; DROP FUNCTION app.opening_unit_price(uuid, text);
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
     OR to_regprocedure('public.test_daftra_custom_fields(uuid)') IS NULL OR to_regprocedure('app.tg_org_service_items_before()') IS NULL THEN
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
