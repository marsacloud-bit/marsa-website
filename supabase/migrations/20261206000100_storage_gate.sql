-- =====================================================================
-- 20261206000100_storage_gate — no appointment while a container's storage (groundage) invoice is unpaid, with a
-- manager override (2026-11-20, owner stage 3ج, docs/owner/transaction-stages-request.md; branch owner/ui-reorg)
--   Owner (Jeddah customs update): the storage invoice issued with the container now falls on the clearance office, so it
--   goes to the client to pay BEFORE the appointment is booked. Recording an appointment for a container whose storage is
--   not settled is refused; a manager may approve booking before payment (who / when / why kept); the follow-up goes on.
--   Jeddah only today — a per-org, per-port SETTING, so another port is a row, not a migration.
--   1. public.status_labels domain 'container_storage_state' (a value list in settings, not a CHECK):
--        none  = no storage invoice · issued = issued, not yet sent to the client · sent = sent, awaiting payment ·
--        paid  = paid. NULL on a container = not answered yet.
--   2. public.containers + storage_state / storage_invoice_no / storage_amount / storage_sent_at / storage_paid_at /
--      storage_note (staff edit them like the other container columns: RLS transport writers, audited by trg_audit).
--      app.tg_containers_storage_before: the state must be a status_labels code; sent_at / paid_at stamped when reached.
--   3. public.storage_gate_ports (org_id, port_code → customs_ports, is_active): the ports where the gate applies. Staff read,
--      the org admin inserts / updates (no DELETE: is_active), audited. Every existing org gets SAJED (Jeddah Islamic Port);
--      a new org gets it through app.tg_organizations_seed_storage_gate.
--   4. public.tx_storage_overrides: the manager approval to book before payment (one live per transaction; insert only
--      through approve_storage_override; staff of the transaction read; audited).
--   5. app.storage_gate_block(tx, container) → NULL | 'unpaid': the gate applies (an active storage_gate_ports row for the
--      transaction's port, a container transaction, not cancelled), no live override, and the container (or, without one,
--      any container of the transaction) has storage_state NULL / issued / sent.
--   6. app.tg_port_appointments_storage_gate: BEFORE INSERT on port_appointments (every path: create_appointment,
--      save_movement, approve_appointment_draft → save_movement) → app.fail('MRS_STORAGE_UNPAID', container_no | 'transaction').
--      Not for a reschedule (rescheduled_from_id: the booking already exists), a closed status (completed / missed /
--      cancelled) or a run without a user request (app.auto_lifecycle_on() false: the legacy import, maintenance).
--   7. public.tx_storage_gate(p_tx) → {applies, port_code, blocked, containers [{id, container_no, storage_state, …}],
--      override {reason, approved_by_name, approved_at} | null, can_override} — staff of the transaction.
--      public.approve_storage_override(p_tx, p_reason) → the override row — senior ops (operations_manager, branch_manager,
--      supervisor, admin) of the transaction; reason 3 … 500 characters; one live override (a second → MRS_CONFLICT).
--   8. conversion: app.convert_keep_tables (20261204000100 body) + storage_gate_ports (kept); app.convert_delete_tables
--      (20261128000100 body) + tx_storage_overrides (deleted, before the transactions).
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS + CREATE / ON CONFLICT).
--   Re-pasting 20261128000100 or 20261204000100 after this file drops the two tables from the conversion lists: re-paste
--   this file straight after.
--   Data: one storage_gate_ports row (SAJED) per existing organisation; no existing container or appointment changes.
--   Down-path: re-create app.convert_keep_tables (20261204000100) and app.convert_delete_tables (20261128000100) verbatim;
--   DROP TRIGGER trg_storage_gate ON public.port_appointments, trg_storage_before ON public.containers,
--   trg_seed_storage_gate ON public.organizations; DROP FUNCTION public.approve_storage_override(uuid, text),
--   public.tx_storage_gate(uuid), app.tg_port_appointments_storage_gate(), app.storage_gate_block(uuid, uuid), app.storage_gate_applies(uuid),
--   app.tg_containers_storage_before(), app.tg_organizations_seed_storage_gate(); DROP TABLE public.tx_storage_overrides,
--   public.storage_gate_ports; ALTER TABLE public.containers DROP COLUMN storage_state, storage_invoice_no, storage_amount,
--   storage_sent_at, storage_paid_at, storage_note; DELETE FROM public.status_labels WHERE domain = 'container_storage_state';
--   DELETE FROM public.schema_versions WHERE version = '20261206000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261205000100') THEN
    RAISE EXCEPTION 'STORAGE GATE preflight: apply service_item_price first (schema_versions lacks 20261205000100)';
  END IF;
  IF to_regclass('public.port_appointments') IS NULL OR to_regclass('public.customs_ports') IS NULL
     OR to_regprocedure('app.senior_ops_roles()') IS NULL OR to_regprocedure('app.auto_lifecycle_on()') IS NULL THEN
    RAISE EXCEPTION 'STORAGE GATE preflight: port_appointments / customs_ports / senior_ops_roles / auto_lifecycle_on missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261206000100', 'storage_gate')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the storage states (settings)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('container_storage_state', 'none',   1, 'لا توجد أرضيات',                    'No storage invoice',          false),
  ('container_storage_state', 'issued', 2, 'صدرت فاتورة أرضيات — لم تُرسل للعميل', 'Storage invoice not sent yet', false),
  ('container_storage_state', 'sent',   3, 'أُرسلت للعميل — بانتظار السداد',       'Sent to the client — unpaid', false),
  ('container_storage_state', 'paid',   4, 'سُددت الأرضيات',                      'Storage paid',                false)
ON CONFLICT (domain, code) DO UPDATE SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
  client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 2. the storage columns of a container
-- ---------------------------------------------------------------------
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS storage_state text;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS storage_invoice_no text;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS storage_amount numeric(12,2);
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS storage_sent_at timestamptz;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS storage_paid_at timestamptz;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS storage_note text;
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_storage_fields_check;
ALTER TABLE public.containers ADD CONSTRAINT containers_storage_fields_check CHECK (
  (storage_invoice_no IS NULL OR char_length(storage_invoice_no) BETWEEN 1 AND 60)
  AND (storage_amount IS NULL OR (storage_amount >= 0 AND storage_amount <= 10000000))
  AND (storage_note IS NULL OR char_length(storage_note) <= 500));
COMMENT ON COLUMN public.containers.storage_state IS 'Storage (groundage) invoice state (20261206000100): status_labels container_storage_state; NULL = not answered yet.';

-- definer: the state list (status_labels via app.is_code) is checked whoever writes; not callable directly (REVOKE below)
CREATE OR REPLACE FUNCTION app.tg_containers_storage_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.storage_state IS NOT NULL AND NOT app.is_code('container_storage_state', NEW.storage_state) THEN
    PERFORM app.fail('MRS_INVALID', 'storage_state');
  END IF;
  NEW.storage_invoice_no := nullif(btrim(coalesce(NEW.storage_invoice_no, '')), '');
  NEW.storage_note := nullif(btrim(coalesce(NEW.storage_note, '')), '');
  IF NEW.storage_state IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.storage_state END) THEN
    IF NEW.storage_state = 'sent' AND NEW.storage_sent_at IS NULL THEN NEW.storage_sent_at := now(); END IF;
    IF NEW.storage_state = 'paid' AND NEW.storage_paid_at IS NULL THEN NEW.storage_paid_at := now(); END IF;
    IF NEW.storage_state IS NULL OR NEW.storage_state IN ('none', 'issued') THEN NEW.storage_sent_at := NULL; NEW.storage_paid_at := NULL; END IF;
    IF NEW.storage_state = 'sent' THEN NEW.storage_paid_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.tg_containers_storage_before() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_storage_before ON public.containers;
CREATE TRIGGER trg_storage_before BEFORE INSERT OR UPDATE ON public.containers
  FOR EACH ROW EXECUTE FUNCTION app.tg_containers_storage_before();

-- ---------------------------------------------------------------------
-- 3. the ports where the gate applies (per org; Jeddah today)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.storage_gate_ports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  port_code   text NOT NULL REFERENCES public.customs_ports(code),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_gate_ports_uniq UNIQUE (org_id, port_code),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.storage_gate_ports IS 'Storage gate (20261206000100): ports where an unpaid storage invoice blocks the appointment (per org; SAJED seeded).';

-- the manager approval to book before the storage is paid
CREATE TABLE IF NOT EXISTS public.tx_storage_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  transaction_id  uuid NOT NULL,
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  approved_by     uuid NOT NULL,
  approved_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tx_storage_overrides_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tx_storage_overrides_live ON public.tx_storage_overrides (transaction_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE public.tx_storage_overrides IS 'Storage gate (20261206000100): a manager approved booking the appointment before the storage invoice is paid (who / when / why).';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['storage_gate_ports','tx_storage_overrides'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_stamp ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_stamp BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_guard BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic(''id'', ''org_id'', ''created_by'', ''created_at'')', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated', t);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS trg_guard ON public.tx_storage_overrides;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.tx_storage_overrides
  FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id', 'org_id', 'transaction_id', 'reason', 'approved_by', 'approved_at', 'created_by', 'created_at');

SELECT app.drop_policies(t) FROM unnest(ARRAY['storage_gate_ports','tx_storage_overrides']) t;
-- the gate ports: staff read; the org admin edits (no DELETE: is_active)
CREATE POLICY storage_gate_ports_select ON public.storage_gate_ports FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY storage_gate_ports_insert ON public.storage_gate_ports FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['admin']));
CREATE POLICY storage_gate_ports_update ON public.storage_gate_ports FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['admin'])) WITH CHECK (app.has_role(org_id, ARRAY['admin']));
REVOKE DELETE ON public.storage_gate_ports FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.storage_gate_ports TO authenticated;
-- the overrides: staff of the transaction read; written only by approve_storage_override (definer)
CREATE POLICY tx_storage_overrides_select ON public.tx_storage_overrides FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
REVOKE INSERT, UPDATE, DELETE ON public.tx_storage_overrides FROM authenticated;
GRANT SELECT ON public.tx_storage_overrides TO authenticated;

-- Jeddah for every existing org; a new org gets it on creation
INSERT INTO public.storage_gate_ports (org_id, port_code)
SELECT o.id, 'SAJED' FROM public.organizations o
 WHERE EXISTS (SELECT 1 FROM public.customs_ports p WHERE p.code = 'SAJED')
ON CONFLICT (org_id, port_code) DO NOTHING;

CREATE OR REPLACE FUNCTION app.tg_organizations_seed_storage_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.customs_ports p WHERE p.code = 'SAJED') THEN
    INSERT INTO public.storage_gate_ports (org_id, port_code) VALUES (NEW.id, 'SAJED') ON CONFLICT (org_id, port_code) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.tg_organizations_seed_storage_gate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_seed_storage_gate ON public.organizations;
CREATE TRIGGER trg_seed_storage_gate AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION app.tg_organizations_seed_storage_gate();

-- ---------------------------------------------------------------------
-- 5. the gate
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.storage_gate_applies(p_tx uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transactions t
                   JOIN public.storage_gate_ports g ON g.org_id = t.org_id AND g.port_code = t.port_code AND g.is_active
                  WHERE t.id = p_tx AND t.cancelled_at IS NULL AND coalesce(t.cargo_unit_type, 'container') = 'container')
$$;
REVOKE ALL ON FUNCTION app.storage_gate_applies(uuid) FROM PUBLIC, anon, authenticated;

-- NULL = the appointment may be recorded; 'unpaid' = refused (no live override and a container not settled)
CREATE OR REPLACE FUNCTION app.storage_gate_block(p_tx uuid, p_container uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.storage_gate_applies(p_tx)
               AND NOT EXISTS (SELECT 1 FROM public.tx_storage_overrides o WHERE o.transaction_id = p_tx AND o.revoked_at IS NULL)
               AND EXISTS (SELECT 1 FROM public.containers c
                            WHERE c.transaction_id = p_tx AND (p_container IS NULL OR c.id = p_container)
                              AND (c.storage_state IS NULL OR c.storage_state IN ('issued', 'sent')))
              THEN 'unpaid' END
$$;
REVOKE ALL ON FUNCTION app.storage_gate_block(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. every new booking passes the gate
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_port_appointments_storage_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_no text;
BEGIN
  IF NEW.rescheduled_from_id IS NOT NULL OR NEW.status IN ('completed', 'missed', 'cancelled') OR NOT app.auto_lifecycle_on() THEN
    RETURN NEW;
  END IF;
  IF app.storage_gate_block(NEW.transaction_id, NEW.container_id) IS NOT NULL THEN
    SELECT c.container_no INTO v_no FROM public.containers c
     WHERE c.transaction_id = NEW.transaction_id AND (NEW.container_id IS NULL OR c.id = NEW.container_id)
       AND (c.storage_state IS NULL OR c.storage_state IN ('issued', 'sent'))
     ORDER BY c.container_no LIMIT 1;
    PERFORM app.fail('MRS_STORAGE_UNPAID', coalesce(v_no, 'transaction'));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.tg_port_appointments_storage_gate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_storage_gate ON public.port_appointments;
CREATE TRIGGER trg_storage_gate BEFORE INSERT ON public.port_appointments
  FOR EACH ROW EXECUTE FUNCTION app.tg_port_appointments_storage_gate();

-- ---------------------------------------------------------------------
-- 7. read + override
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tx_storage_gate(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_o public.tx_storage_overrides; v_applies boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_t FROM public.transactions t WHERE t.id = p_tx;
  IF v_t.id IS NULL OR NOT app.has_tx_role(v_t.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  v_applies := app.storage_gate_applies(v_t.id);
  SELECT * INTO v_o FROM public.tx_storage_overrides o WHERE o.transaction_id = v_t.id AND o.revoked_at IS NULL;
  RETURN jsonb_build_object(
    'applies', v_applies, 'port_code', v_t.port_code,
    'blocked', app.storage_gate_block(v_t.id, NULL) IS NOT NULL,
    'containers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'container_no', c.container_no, 'storage_state', c.storage_state,
                                              'storage_invoice_no', c.storage_invoice_no, 'storage_amount', c.storage_amount,
                                              'storage_sent_at', c.storage_sent_at, 'storage_paid_at', c.storage_paid_at,
                                              'storage_note', c.storage_note) ORDER BY c.container_no)
                              FROM public.containers c WHERE c.transaction_id = v_t.id), '[]'::jsonb),
    'override', CASE WHEN v_o.id IS NOT NULL THEN jsonb_build_object('id', v_o.id, 'reason', v_o.reason, 'approved_at', v_o.approved_at,
                       'approved_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = v_o.approved_by)) END,
    'can_override', v_applies AND app.has_tx_role(v_t.id, app.senior_ops_roles()));
END $$;
REVOKE EXECUTE ON FUNCTION public.tx_storage_gate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tx_storage_gate(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_storage_override(p_tx uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_o public.tx_storage_overrides; v_r text := btrim(coalesce(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_t FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v_t.id IS NULL OR NOT app.has_tx_role(v_t.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_tx_role(v_t.id, app.senior_ops_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'storage_override'); END IF;
  IF v_t.cancelled_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  IF char_length(v_r) NOT BETWEEN 3 AND 500 THEN PERFORM app.fail('MRS_INVALID', 'reason'); END IF;
  IF EXISTS (SELECT 1 FROM public.tx_storage_overrides o WHERE o.transaction_id = v_t.id AND o.revoked_at IS NULL) THEN
    PERFORM app.fail('MRS_CONFLICT', 'storage_override');
  END IF;
  INSERT INTO public.tx_storage_overrides (org_id, transaction_id, reason, approved_by)
  VALUES (v_t.org_id, v_t.id, v_r, auth.uid()) RETURNING * INTO v_o;
  RETURN jsonb_build_object('id', v_o.id, 'transaction_id', v_o.transaction_id, 'reason', v_o.reason, 'approved_at', v_o.approved_at);
END $$;
REVOKE EXECUTE ON FUNCTION public.approve_storage_override(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_storage_override(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 8. conversion (20261115000100 convert_in_place): the gate ports are settings, KEPT; the overrides are transaction data,
--    DELETED before the transactions — app.convert_keep_tables (20261204000100 body + public.storage_gate_ports) and
--    app.convert_delete_tables (20261128000100 body + public.tx_storage_overrides) re-created
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.convert_keep_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.branches', 'public.memberships', 'public.org_counters', 'public.org_usage_counters',
    'public.msg_channels', 'public.msg_settings', 'public.msg_auto_reply_policies', 'public.msg_templates',
    'public.msg_instructions', 'public.daftra_connections', 'public.daftra_item_links', 'public.document_requirements',
    'public.org_subscriptions', 'public.subscription_events', 'app.ai_settings',
    'public.org_service_items',                                                                         -- LEGACY
    'public.tx_stage_sets', 'public.tx_stage_steps',                                                    -- owner stages
    'public.storage_gate_ports',                                                                        -- storage gate (20261206000100)
    -- append-only / log tables
    'public.audit_log', 'public.report_exports', 'app.ai_usage', 'public.operational_alert_runs', 'public.client_errors'
  ]::text[]
$$;

CREATE OR REPLACE FUNCTION app.convert_delete_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    -- intake / clients / access
    'public.service_requests', 'public.clients', 'public.client_aliases', 'public.client_users', 'public.invitations',
    'public.idempotency_keys', 'public.import_batches', 'public.import_rows', 'public.contact_messages',
    -- operations
    'public.tx_storage_overrides',                                                                                -- SG (20261206000100)
    'public.transactions', 'public.transaction_events', 'public.transaction_bls', 'public.bills_of_lading',
    'public.customs_declarations', 'public.containers', 'public.documents', 'public.document_extractions',
    'public.document_matches',
    'public.doc_batches', 'public.doc_batch_documents', 'public.transaction_shipment_data',
    'public.shipment_invoice_items', 'public.shipment_packing_items',
    'public.declaration_approvals', 'public.declaration_items', 'public.hs_reference',
    'public.parties', 'public.party_ports',
    'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
    'public.appointment_drafts', 'public.appointment_draft_cards', 'public.empty_return_proofs',
    'public.demurrage_cases', 'public.operational_exceptions', 'public.operational_alerts',
    -- costs (G4)
    'public.cost_accruals', 'public.cost_adjustments', 'public.cost_allocations', 'public.client_charges',
    'public.charge_collections', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.supplier_payments',
    'public.finance_documents',
    'public.client_disbursements', 'public.disbursement_allocations', 'public.payment_documents',                -- PAY
    'public.client_custody_entries',                                                                              -- PAY
    -- billing (G5)
    'public.billing_intents', 'public.billing_intent_lines', 'public.billing_review_items', 'public.billing_sync_jobs',
    'public.billing_sync_attempts', 'public.daftra_client_links', 'public.daftra_mock_accounts',
    'public.daftra_runs', 'public.daftra_client_import_rows', 'public.daftra_invoice_candidates',                -- L7
    'public.daftra_supplier_links', 'public.daftra_purchase_drafts',                                              -- L7
    -- inbox (G6b)
    'public.msg_threads', 'public.msg_messages', 'public.msg_message_events', 'public.msg_attachments',
    'public.msg_extractions', 'public.msg_summaries', 'public.msg_classifications', 'public.msg_ai_runs',
    'public.msg_replies', 'public.msg_reply_versions', 'public.msg_reply_approvals', 'public.msg_outbound',
    'public.msg_delivery_events', 'public.msg_jobs', 'public.msg_job_attempts', 'public.msg_thread_links',
    'public.msg_contacts', 'public.msg_contact_addresses', 'public.msg_contact_authorizations', 'public.msg_mock_mailboxes',
    -- legacy import (LI): staged rows, then the runs (transactions.import_run_id points to a run)
    'public.legacy_import_rows', 'public.legacy_import_runs',
    -- RX: empty-return extension requests
    'public.return_extension_requests'
  ]::text[]
$$;
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables() FROM PUBLIC, anon, authenticated, service_role;
