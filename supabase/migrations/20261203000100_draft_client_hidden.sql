-- =====================================================================
-- 20261203000100_draft_client_hidden — a DRAFT transaction is hidden from the client (2026-11-16)
--   A draft (public.transactions.is_draft = true, 20261127000100_tx_draft_approval: made by create_draft_transaction from
--   the B/L + invoice readings, approved by approve_transaction) is promised on ocr.html «لا تظهر للعميل حتى تُعتمد», but
--   only its 'created' event was hidden (visible_to_client = NOT is_draft): the portal client read the transaction itself
--   and everything hanging off it. Every client path now excludes drafts; staff visibility is unchanged:
--   1. app.is_tx_client(p_tx) (20261031000300 body, re-created): + AND NOT t.is_draft. It is THE client test of every
--      transaction-linked row, so through it (unchanged bodies / policies):
--        app.can_read_transaction → containers_select, transaction_bls_select;
--        customs_declarations_select; events_select (visible_to_client AND is_tx_client); documents_select +
--        documents_insert (a client neither reads nor uploads a document of a draft) → storage.objects
--        marsa_documents_read (EXISTS on public.documents under the caller's RLS).
--      Appointments, trips, movements, payments / costs / billing rows, messages and the reports / dashboards are staff-only
--      (has_tx_role / has_branch_role / rpt_gate_staff): no client path to change.
--   2. policy transactions_select (20261031000300, never re-created since): the client half becomes
--      (NOT is_draft AND app.is_client_user(client_id)); the staff half is identical.
--   3. public.portal_invoices(p_tx) (20261106000100 body, re-created): no invoice of a draft in the list; p_tx = a draft
--      → MRS_NOT_FOUND transaction (as for a transaction of another client).
--   4. public.public_track(p_ref, p_token) (20261118000100 body, re-created): a draft is never found — by its own ref +
--      token → {"not_found": true}; a request converted into a draft shows the request only (no 'transaction' key).
--   5. app.is_bl_client(p_bl) (20261103000100 body, re-created) → bills_of_lading_select: its second half («linked to NO
--      transaction of another client») tested NOT is_tx_client per link, so with 1. a draft of the SAME client linked to the
--      B/L (split B/L, OCR flow for the rest of the shipment) counted as foreign and hid the B/L of the client's live
--      transaction. Now: visible when linked to one of the caller's non-draft transactions (is_tx_client) and to no
--      transaction whose client is not one of the caller's clients (drafts included); a draft of the caller's own client
--      neither shows the B/L (a B/L linked to the draft only stays hidden) nor hides it.
--   After approve_transaction (is_draft = false) the client sees the transaction and its events by the existing
--   visible_to_client rules (the draft's 'created' event stays hidden; 'tx_approval' and the other client events show).
--   CREATE OR REPLACE keeps each function's privileges (is_tx_client, is_bl_client: authenticated; portal_invoices:
--   authenticated + service_role; public_track: anon + authenticated + service_role). MFA stays off (20261129000100): no
--   aal2 requirement.
--   Re-runnable (CREATE OR REPLACE / DROP POLICY IF EXISTS + CREATE / ON CONFLICT); changes no data.
--   Re-pasting 20261031000300 (is_tx_client, transactions_select), 20261103000100 (is_bl_client), 20261106000100
--   (portal_invoices) or 20261112000100 / 20261113000100 / 20261118000100 (public_track) after this file shows drafts to the
--   client again (20261103000100: hides a B/L shared with a draft of the same client): re-paste this file straight after.
--   Down-path: re-create app.is_tx_client and policy transactions_select from 20261031000300, app.is_bl_client from
--   20261103000100, public.portal_invoices from 20261106000100 and public.public_track from 20261118000100 (their bodies,
--   verbatim); DELETE FROM public.schema_versions WHERE version = '20261203000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261202000100') THEN
    RAISE EXCEPTION 'DRAFT CLIENT HIDDEN preflight: apply org_logo first (schema_versions lacks 20261202000100)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.transactions'::regclass AND attname = 'is_draft' AND NOT attisdropped)
     OR to_regprocedure('app.is_tx_client(uuid)') IS NULL OR to_regprocedure('app.is_bl_client(uuid)') IS NULL
     OR to_regprocedure('public.portal_invoices(uuid)') IS NULL
     OR to_regprocedure('public.public_track(text,text)') IS NULL OR to_regprocedure('public.approve_transaction(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'DRAFT CLIENT HIDDEN preflight: transactions.is_draft / approve_transaction (20261127000100) or is_tx_client / is_bl_client / portal_invoices / public_track missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261203000100', 'draft_client_hidden')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the client test of a transaction-linked row: never a draft
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_tx_client(p_tx uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = p_tx AND NOT t.is_draft AND app.is_client_user(t.client_id))
$$;

-- ---------------------------------------------------------------------
-- 2. transactions: staff unchanged; a client sees its own transactions that are not drafts
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS transactions_select ON public.transactions;
CREATE POLICY transactions_select ON public.transactions FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.staff_roles()) OR (NOT is_draft AND app.is_client_user(client_id)));

-- ---------------------------------------------------------------------
-- 3. portal invoices: none of a draft
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_invoices(p_tx uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_items jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = p_tx AND t.is_draft)                     -- DRAFT HIDDEN
          OR (NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = p_tx AND t.client_id IN (SELECT app.my_client_ids()))
              AND NOT EXISTS (SELECT 1 FROM public.billing_intents i WHERE i.transaction_id = p_tx AND i.status = 'issued'
                                 AND i.client_id IN (SELECT app.my_client_ids())))) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'transaction_id', x.transaction_id, 'transaction_ref', x.ref,
           'daftra_number', x.daftra_number, 'issued_at', x.issued_at, 'currency', x.currency,
           'net', x.remote_net, 'vat', x.remote_vat, 'total', x.remote_total,
           'payment_status', x.payment_status, 'paid_amount', x.paid_amount,
           'remote_state', CASE WHEN x.cancelled THEN 'cancelled' ELSE 'issued' END)
           ORDER BY x.issued_at DESC NULLS LAST, x.id), '[]'::jsonb)
    INTO v_items
    FROM (SELECT i.id, i.transaction_id, t.ref, i.daftra_number, i.issued_at, i.currency::text currency,
                 round(i.remote_net, 2) remote_net, round(i.remote_vat, 2) remote_vat, round(i.remote_total, 2) remote_total,
                 i.payment_status, round(i.paid_amount, 2) paid_amount,
                 app.rpt_bill_cancelled(i.id) cancelled
            FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id AND t.org_id = i.org_id
                                                                        AND NOT t.is_draft   -- DRAFT HIDDEN
           WHERE i.status = 'issued' AND i.client_id IN (SELECT app.my_client_ids())
             AND (p_tx IS NULL OR i.transaction_id = p_tx)
           ORDER BY i.issued_at DESC NULLS LAST, i.id LIMIT 200) x;
  RETURN jsonb_build_object('items', v_items, 'count', jsonb_array_length(v_items));
END $$;

-- ---------------------------------------------------------------------
-- 4. public tracking: a draft is never found (a request converted into a draft shows the request only)
-- ---------------------------------------------------------------------
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
  v_cl   public.status_labels;
BEGIN
  PERFORM app.antispam_gate('track', NULL);                                                          -- AS
  IF v_ref !~ '^[A-Z]{2,5}-[0-9]{4}-[0-9]{6,}$' OR v_tok !~ '^[0-9a-f]{64}$' THEN
    IF app.mfa_pending() THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;                             -- AS
    RETURN jsonb_build_object('not_found', true);                                                    -- AS
  END IF;
  v_hash := app.hash_token(v_tok);

  SELECT * INTO v_req FROM public.service_requests r WHERE r.ref = v_ref AND r.tracking_token_hash = v_hash LIMIT 1;
  IF v_req.id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.request_id = v_req.id AND NOT t.is_draft;          -- DRAFT HIDDEN
  ELSE
    SELECT * INTO v_tx FROM public.transactions t
     WHERE t.ref = v_ref AND t.tracking_token_hash = v_hash AND NOT t.is_draft LIMIT 1;                -- DRAFT HIDDEN
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
    SELECT * INTO v_cl FROM public.status_labels s WHERE s.domain = 'transaction_state' AND s.code = 'cancelled';     -- LEGACY TX
    SELECT coalesce(jsonb_agg(jsonb_build_object('status', e.to_status,
                                                 'label_ar', CASE WHEN e.payload ->> 'op' = 'cancelled' THEN v_cl.label_ar ELSE s.label_ar END,
                                                 'label_en', CASE WHEN e.payload ->> 'op' = 'cancelled' THEN v_cl.label_en ELSE s.label_en END,
                                                 'at', e.created_at) ORDER BY e.created_at, e.id), '[]'::jsonb)
      INTO v_tl
      FROM public.transaction_events e
      JOIN public.status_labels s ON s.domain = 'operational_status' AND s.code = e.to_status
     WHERE e.transaction_id = v_tx.id AND e.visible_to_client AND e.event_type IN ('created','operational_status');
    v_res := v_res || jsonb_build_object('transaction', jsonb_build_object(
      'ref', v_tx.ref,
      'operation', v_tx.operation, 'mode', v_tx.mode,
      'operational_status', v_tx.operational_status,
      'status_label_ar', CASE WHEN v_tx.cancelled_at IS NOT NULL THEN v_cl.label_ar
        ELSE (SELECT s.label_ar FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status) END,
      'status_label_en', CASE WHEN v_tx.cancelled_at IS NOT NULL THEN v_cl.label_en
        ELSE (SELECT s.label_en FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status) END,
      'stage_index', (SELECT s.sort FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'stage_total', 10,
      'cancelled', v_tx.cancelled_at IS NOT NULL, 'cancelled_at', v_tx.cancelled_at,                               -- LEGACY TX
      'status_changed_at', v_tx.status_changed_at,
      'containers', (SELECT jsonb_build_object(
                        'total', count(*),
                        'returned', count(*) FILTER (WHERE c.return_status IN ('returned_verified','waived')))
                     FROM public.containers c WHERE c.transaction_id = v_tx.id),
      'timeline', v_tl));
  END IF;
  RETURN v_res;
END $$;

-- ---------------------------------------------------------------------
-- 5. B/L client visibility: a draft of the caller's own client is ignored (neither shows nor hides the B/L);
--    a transaction of another client (draft or not) still hides it
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_bl_client(p_bl uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.bl_id = p_bl AND app.is_tx_client(tb.transaction_id))
     AND NOT EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.transactions t ON t.id = tb.transaction_id
                      WHERE tb.bl_id = p_bl AND NOT app.is_client_user(t.client_id))
$$;
