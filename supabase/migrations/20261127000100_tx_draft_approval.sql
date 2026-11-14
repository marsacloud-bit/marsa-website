-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261127000100 — draft transaction from the matching report, approval after the customs
-- declaration (the owner's workflow: 1) the B/L + commercial invoice are read together on ocr.html — «هنا بدأت المعاملة», a
-- DRAFT; 2) the staff enter it in Fasah and Fasah issues the declaration; 3) the declaration is read, approved, compared with
-- the invoice + B/L (three-way match) and the transaction is approved «يعتمدها كمعاملة»). Builds on legacy_docs
-- (approve_doc_batch, 20261119000100), legacy_decl (declaration_approvals, 20261120000100) and doc_match_packing
-- (document_matches, 20261126000100).
--   P. preflight (doc_match_packing applied, approve_doc_batch / declaration_approvals / document_matches present) +
--      schema_versions row
--   1. columns      public.transactions + is_draft boolean NOT NULL DEFAULT false (every existing row stays an active,
--                   approved-by-history transaction: no backfill), approved_at, approved_by, approval_match_id (composite FK →
--                   document_matches like the other match references), approval_note (≤ 1000, internal); checks: a draft
--                   is never approved (transactions_draft_approval_chk), approval_* only with approved_at; a partial index
--                   of the live drafts per org. Column SELECT grant to authenticated for is_draft / approved_at /
--                   approved_by / approval_match_id (transactions SELECT is column-granted since G5; approval_note stays
--                   hidden: staff read it through get_transaction_approval).
--   2. guard        app.tg_transactions_draft_guard() + trigger trg_draft_guard (BEFORE INSERT OR UPDATE, SECURITY INVOKER
--                   like trg_li_guard of 20261125000100): an API caller can neither set (INSERT: forced false / NULL) nor
--                   change (UPDATE: MRS_IMMUTABLE) is_draft / approved_* / approval_*; a definer insert made while
--                   public.create_draft_transaction holds the transaction-local setting marsa.tx_draft = 'on' becomes a
--                   draft. A separate trigger instead of a re-created app.tg_transactions_legacy_guard: no copied body.
--   3. trigger      app.tg_transactions_created() re-created (body of 20261031000300 + visible_to_client = NOT is_draft,
--                   payload {ref, draft}): a draft is not announced in the client portal timeline.
--   4. events       transaction_events_event_type_check = the 20261107000100 list + 'tx_approval'; status_labels
--                   audit_event.tx_approval (the audit trail label).
--   5. RPCs         public.create_draft_transaction(p_batch, p_payload) — a draft doc batch (B/L + invoice (+ packing)
--                   readings) becomes a DRAFT transaction through public.approve_doc_batch (unchanged): server-side the
--                   rules of the new-transaction form (admin.js): sea / air → B/L number required (MRS_REQUIRED
--                   bl_number), sea and not Ro-Ro → ≥ 1 container (MRS_REQUIRED containers), Ro-Ro with containers in
--                   the draft → MRS_INVALID containers_roro, Ro-Ro needs the chassis (MRS_REQUIRED chassis_no);
--                   cargo_unit_type 'roro' + chassis / plate set after the insert (no container; duplicate guard on chassis).
--                   public.approve_transaction(p_tx, p_payload) — the draft becomes an approved transaction: the latest
--                   declaration approval of the transaction + a saved three-way match of this transaction on that
--                   declaration reading (not voided, engine match-v1 / match-v2, invoice + B/L readings linked to the
--                   transaction); a match that is not a clean «match» needs confirm_mismatch + a note
--                   (MRS_TX_MATCH_MISMATCH); event 'tx_approval' (client visible, payload without the note); the
--                   operational stage is NOT changed. public.get_transaction_approval(p_tx) — the read side of the
--                   transaction page (draft / approval state, latest declaration approval, latest three-way match).
--   6. privileges
-- No four-eyes rule (like approve_declaration_extraction and review_document_match). A draft is a real MRS record: it counts
-- toward the G7 monthly quota and shows in staff lists; an abandoned draft is cancelled with cancel_transaction.
-- Errors: MRS_TX_NOT_DRAFT (approve of a transaction that is not a draft, or approved on another match), MRS_TX_MATCH_MISMATCH
-- (a mismatch / missing / review match without confirm_mismatch + note); existing codes otherwise (a cancelled transaction:
-- MRS_BAD_TRANSITION cancelled from app.g3_lock_tx;
-- MRS_REQUIRED bl_number / containers / chassis_no / declaration_approval / match_id / new_transaction, MRS_INVALID match_id /
-- transaction_id / cargo_unit_type / containers_roro, MRS_DOC_BATCH_STATE, MRS_DUPLICATE_TX, MRS_IDEMPOTENCY_CONFLICT,
-- MRS_NOT_FOUND, MRS_FORBIDDEN, MRS_IMMUTABLE).
-- Re-runnable (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE /
-- DROP TRIGGER IF EXISTS + CREATE / ON CONFLICT); re-running on itself leaves an identical catalog; changes no data.
-- Re-pasting 20261031000300 or 20261107000100 after this file restores the old 'created' trigger / narrows the event types
-- (and aborts once a 'tx_approval' event exists): re-paste this file right after.
-- Down-path (staging only): approve or cancel the drafts first; DROP FUNCTION public.create_draft_transaction(uuid, jsonb),
-- public.approve_transaction(uuid, jsonb), public.get_transaction_approval(uuid); DROP TRIGGER trg_draft_guard ON
-- public.transactions; DROP FUNCTION app.tg_transactions_draft_guard(); re-paste 20261031000300 §(created trigger) and
-- 20261107000100 §(event types) only when no 'tx_approval' event exists; ALTER TABLE public.transactions DROP COLUMN is_draft,
-- approved_at, approved_by, approval_match_id, approval_note.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261126000100') THEN
    RAISE EXCEPTION 'TX DRAFT preflight: apply doc_match_packing first (schema_versions lacks 20261126000100 doc_match_packing)';
  END IF;
  IF to_regprocedure('public.approve_doc_batch(uuid,jsonb)') IS NULL OR to_regclass('public.declaration_approvals') IS NULL
     OR to_regclass('public.document_matches') IS NULL OR to_regprocedure('app.g3_lock_tx(uuid,text[])') IS NULL
     OR to_regprocedure('app.doc_batch_lock(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'TX DRAFT preflight: legacy_docs / legacy_decl / doc_match objects missing (apply 20261119000100 … 20261126000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261127000100', 'tx_draft_approval')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. columns: draft / approval
-- ---------------------------------------------------------------------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS is_draft boolean NOT NULL DEFAULT false;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS approval_match_id uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS approval_note text;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_approval_match_fk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_approval_match_fk
  FOREIGN KEY (approval_match_id, org_id) REFERENCES public.document_matches(id, org_id);
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_approval_note_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_approval_note_chk CHECK (char_length(approval_note) <= 1000);
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_draft_approval_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_draft_approval_chk CHECK (
  NOT (is_draft AND approved_at IS NOT NULL)
  AND (approved_at IS NOT NULL OR (approved_by IS NULL AND approval_match_id IS NULL AND approval_note IS NULL)));
CREATE INDEX IF NOT EXISTS transactions_draft_idx ON public.transactions (org_id) WHERE is_draft AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_approval_match_idx ON public.transactions (approval_match_id) WHERE approval_match_id IS NOT NULL;
COMMENT ON COLUMN public.transactions.is_draft IS 'Draft transaction (20261127000100): created from the B/L + invoice readings by public.create_draft_transaction, before the customs declaration; becomes false through public.approve_transaction. Default false: every transaction created any other way is active. Server-set only (trg_draft_guard).';
COMMENT ON COLUMN public.transactions.approved_at IS 'When the draft was approved after the declaration + three-way match (public.approve_transaction, 20261127000100). NULL on transactions that were never drafts.';
COMMENT ON COLUMN public.transactions.approved_by IS 'Who approved the draft (public.approve_transaction, 20261127000100).';
COMMENT ON COLUMN public.transactions.approval_match_id IS 'The saved three-way document match (invoice ↔ B/L ↔ customs declaration) the approval relied on (20261127000100).';
COMMENT ON COLUMN public.transactions.approval_note IS 'Internal note of the approval (required when the match was not a clean match), ≤ 1000. Not column-granted: read through public.get_transaction_approval (20261127000100).';

-- transactions SELECT is column-granted (G5 / legacy_core: fail closed): the flags are readable by staff lists; the note is not
GRANT SELECT (is_draft, approved_at, approved_by, approval_match_id) ON public.transactions TO authenticated;

-- ---------------------------------------------------------------------
-- 2. guard: only the definer RPCs create a draft or approve one
-- ---------------------------------------------------------------------
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_transactions_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_draft := false; NEW.approved_at := NULL; NEW.approved_by := NULL; NEW.approval_match_id := NULL; NEW.approval_note := NULL;
    ELSE
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW),
        ARRAY['is_draft','approved_at','approved_by','approval_match_id','approval_note']);
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    -- set (transaction-local) by public.create_draft_transaction only, around its call of approve_doc_batch
    IF coalesce(current_setting('marsa.tx_draft', true), '') = 'on' THEN
      NEW.is_draft := true; NEW.approved_at := NULL; NEW.approved_by := NULL; NEW.approval_match_id := NULL; NEW.approval_note := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_draft_guard ON public.transactions;
CREATE TRIGGER trg_draft_guard BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_draft_guard();

-- ---------------------------------------------------------------------
-- 3. the 'created' event (20261031000300, re-created): hidden from the client while the transaction is a draft
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_transactions_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, to_status, visible_to_client, actor, payload)
  VALUES (NEW.org_id, NEW.id, 'created', NEW.operational_status, NOT NEW.is_draft, auth.uid(),
          jsonb_build_object('ref', NEW.ref, 'draft', NEW.is_draft));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_created ON public.transactions;
CREATE TRIGGER trg_created AFTER INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_created();

-- ---------------------------------------------------------------------
-- 4. event types: the 20261107000100 list + 'tx_approval'; audit label
-- ---------------------------------------------------------------------
ALTER TABLE public.transaction_events DROP CONSTRAINT IF EXISTS transaction_events_event_type_check;
ALTER TABLE public.transaction_events ADD CONSTRAINT transaction_events_event_type_check CHECK (event_type IN
  ('created','request_converted','operational_status','financial_status','container_return','document','note','tracking_token',
   -- G3 (A): declarations, B/L links, container operational state
   'declaration','bl','container',
   -- G3 (B): appointments, transport trips, operational exceptions, document-requirement overrides
   'appointment','trip','exception','docs_override',
   -- G4: finance (internal; payload {op, entity, id, …ids}, never amounts)
   'finance',
   -- G5: billing / Daftra sync (internal; payload {op, entity, id, …ids}, never amounts nor bodies)
   'billing',
   -- G6b: messaging (internal; payload {op, entity, id, thread_id, …}, never bodies, subjects, addresses)
   'message',
   -- 20261127000100: the draft transaction approved after the declaration + three-way match (payload {match_id, overall,
   -- counts, declaration_id, confirmed_mismatch}, never the note)
   'tx_approval'));

INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('audit_event','tx_approval',19,'اعتماد المعاملة','Transaction approved',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------
-- create_draft_transaction(p_batch, {version, new_transaction {client_id, operation?, mode?}, cargo_unit_type?, chassis_no? (Ro-Ro:
-- required), vehicle_plate_no?, shipping_agent_id?, confirm_client?, idempotencyKey?}) — an ops writer of the batch's branch: the draft batch (not tied to a transaction)
-- becomes a NEW transaction marked as a draft, in one atomic step through approve_doc_batch (client, B/L, containers through
-- the duplicate guard, بيانات فسح, invoice / packing items, readings linked + reviewed, batch approved). Server-side rules of
-- the new-transaction form: sea / air need the B/L number, sea needs ≥ 1 container unless Ro-Ro. The port is not required
-- (inferred from the port of discharge; the completeness section shows it missing). → the approve_doc_batch result +
-- {transaction_id, ref, is_draft: true, cargo_unit_type}
CREATE OR REPLACE FUNCTION public.create_draft_transaction(p_batch uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); b public.doc_batches; v_key uuid; v_replay jsonb; v_new jsonb; v_mode text;
  v_cut text; v_chassis text; v_plate text; ts jsonb; tiv jsonb; tpk jsonb; v_bl text; v_nctr int; v_inner jsonb; v_tx public.transactions; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  b := app.doc_batch_lock(p_batch, false);
  PERFORM app.only_keys(p, ARRAY['version','new_transaction','cargo_unit_type','chassis_no','vehicle_plate_no','shipping_agent_id',
                                 'confirm_client','idempotencyKey']);
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('create_draft_transaction', v_key, jsonb_build_object('batch', b.id, 'p', p - 'idempotencyKey'), b.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF b.status <> 'draft' THEN PERFORM app.fail('MRS_DOC_BATCH_STATE', b.status); END IF;
  -- a batch of an existing transaction is approved into it (approve_doc_batch), never made a second, draft transaction
  IF b.transaction_id IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'transaction_id'); END IF;
  v_new := p -> 'new_transaction';
  IF v_new IS NULL OR jsonb_typeof(v_new) <> 'object' THEN PERFORM app.fail('MRS_REQUIRED', 'new_transaction'); END IF;
  v_mode := coalesce(app.ptext(v_new, 'mode', 10), 'sea');
  IF v_mode NOT IN ('sea','air','land') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  v_cut := coalesce(app.ptext(p, 'cargo_unit_type', 20), 'container');
  IF v_cut NOT IN ('container','roro') THEN PERFORM app.fail('MRS_INVALID', 'cargo_unit_type'); END IF;
  -- Ro-Ro carries a vehicle: the chassis is required (transactions_roro_chk), the plate optional; both normalised by the norm trigger
  v_chassis := app.ptext(p, 'chassis_no', 40);
  v_plate := app.ptext(p, 'vehicle_plate_no', 20);

  -- the rules of the new-transaction form (admin.js, legacy validateTransaction_) on the saved batch draft
  ts := coalesce(nullif(b.draft -> 'shipment', 'null'), '{}'::jsonb);
  tiv := coalesce(nullif(b.draft -> 'invoice', 'null'), '{}'::jsonb);
  tpk := coalesce(nullif(b.draft -> 'packing', 'null'), '{}'::jsonb);
  v_bl := coalesce(app.doc_bl_no(app.doc_val(ts -> 'bl_number')), app.doc_bl_no(app.doc_val(tiv -> 'bl_number')),
                   app.doc_bl_no(app.doc_val(tpk -> 'bl_number')));
  v_nctr := CASE WHEN jsonb_typeof(ts -> 'containers') = 'array' THEN jsonb_array_length(ts -> 'containers') ELSE 0 END;
  IF v_mode IN ('sea','air') AND v_bl IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bl_number'); END IF;
  IF v_cut = 'roro' AND v_nctr > 0 THEN PERFORM app.fail('MRS_INVALID', 'containers_roro'); END IF;
  IF v_mode = 'sea' AND v_cut <> 'roro' AND v_nctr = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'containers'); END IF;
  IF v_cut = 'roro' AND v_chassis IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'chassis_no'); END IF;
  IF v_cut <> 'roro' AND (v_chassis IS NOT NULL OR v_plate IS NOT NULL) THEN PERFORM app.fail('MRS_INVALID', 'chassis_no'); END IF;

  -- the new transaction is inserted by approve_doc_batch while marsa.tx_draft = 'on' (trg_draft_guard → is_draft); the
  -- inner call gets a key derived from this one (a retry of this call replays above, before reaching it)
  PERFORM set_config('marsa.tx_draft', 'on', true);
  v_inner := public.approve_doc_batch(b.id, jsonb_strip_nulls(jsonb_build_object(
    'version', p -> 'version', 'new_transaction', v_new, 'shipping_agent_id', p -> 'shipping_agent_id',
    'confirm_client', p -> 'confirm_client',
    'idempotencyKey', CASE WHEN v_key IS NULL THEN NULL ELSE md5('create_draft_transaction:' || v_key::text)::uuid::text END)));
  PERFORM set_config('marsa.tx_draft', '', true);

  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = (v_inner ->> 'transaction_id')::uuid FOR UPDATE;
  IF v_tx.id IS NULL OR NOT coalesce((v_inner ->> 'created_transaction')::boolean, false) OR NOT v_tx.is_draft THEN
    PERFORM app.fail('MRS_INVALID', 'transaction_id');
  END IF;
  IF v_cut = 'roro' THEN
    -- the step-2 duplicate guard checks B/L + chassis on this update (MRS_DUPLICATE_TX chassis rolls everything back)
    UPDATE public.transactions t SET cargo_unit_type = 'roro', chassis_no = v_chassis, vehicle_plate_no = v_plate
     WHERE t.id = v_tx.id RETURNING * INTO v_tx;
  END IF;
  v_res := v_inner || jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'is_draft', true,
                                         'cargo_unit_type', v_tx.cargo_unit_type, 'mode', v_tx.mode, 'operation', v_tx.operation);
  PERFORM app.idem_finish('create_draft_transaction', v_key, v_res);
  RETURN v_res;
END $$;

-- the state of a transaction's draft / approval (shared by approve_transaction and get_transaction_approval)
CREATE OR REPLACE FUNCTION app.tx_approval_json(p_tx uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'transaction_id', t.id, 'ref', t.ref, 'is_draft', t.is_draft, 'approved_at', t.approved_at, 'approved_by', t.approved_by,
    'approved_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = t.approved_by),
    'approval_match_id', t.approval_match_id, 'approval_note', t.approval_note, 'cancelled', t.cancelled_at IS NOT NULL,
    'operational_status', t.operational_status,
    'has_declaration', EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id),
    'declaration_approval', (SELECT jsonb_build_object('id', a.id, 'extraction_id', a.extraction_id, 'declaration_id', a.declaration_id,
                                                       'approved_at', a.approved_at, 'bl_status', a.bl_status)
                               FROM public.declaration_approvals a WHERE a.transaction_id = t.id
                              ORDER BY a.approved_at DESC, a.id DESC LIMIT 1),
    'last_three_way_match', (SELECT jsonb_build_object('id', m.id, 'created_at', m.created_at, 'overall', m.overall,
                                                       'engine_version', m.engine_version, 'declaration_extraction_id', m.declaration_extraction_id,
                                                       'status', m.status, 'counts', jsonb_build_object('match', m.match_count,
                                                         'mismatch', m.mismatch_count, 'partial', m.partial_count, 'missing', m.missing_count))
                               FROM public.document_matches m WHERE m.transaction_id = t.id AND m.mode = 'three_way' AND m.voided_at IS NULL
                              ORDER BY m.created_at DESC, m.id DESC LIMIT 1))
    FROM public.transactions t WHERE t.id = p_tx
$$;

-- approve_transaction(p_tx, {match_id, confirm_mismatch?, note?, idempotencyKey?}) — an ops writer of the branch: the draft
-- becomes an approved transaction once its declaration is approved (declaration_approvals, the existing rules) and a saved
-- three-way match of this transaction compares the invoice + B/L with THAT declaration reading. A match that is not a clean
-- «match» (overall review / mismatch, or mismatched / missing rows) needs confirm_mismatch: true and a note. The stage is not
-- changed (the declaration triggers already moved it). → {transaction_id, ref, is_draft: false, approved_at, approved_by,
-- approval_match_id, …}
CREATE OR REPLACE FUNCTION public.approve_transaction(p_tx uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_tx public.transactions; v_key uuid; v_replay jsonb; v_match uuid;
  m public.document_matches; a public.declaration_approvals; v_note text; v_clean boolean; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_tx := app.g3_lock_tx(p_tx, app.ops_writer_roles());   -- a cancelled transaction → MRS_BAD_TRANSITION cancelled (legacy_core)
  PERFORM app.only_keys(p, ARRAY['match_id','confirm_mismatch','note','idempotencyKey']);
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('approve_transaction', v_key, jsonb_build_object('transaction', v_tx.id, 'p', p - 'idempotencyKey'), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_match := app.puuid(p, 'match_id');
  IF v_match IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'match_id'); END IF;
  IF NOT v_tx.is_draft THEN
    -- already approved on this match: the current state (a lost answer retried without its key)
    IF v_tx.approved_at IS NOT NULL AND v_tx.approval_match_id = v_match THEN
      -- the key row opened by idem_begin above is completed too (a later retry with this key replays, never MRS_IN_PROGRESS)
      RETURN app.idem_finish('approve_transaction', v_key, app.tx_approval_json(v_tx.id) || jsonb_build_object('already_approved', true));
    END IF;
    PERFORM app.fail('MRS_TX_NOT_DRAFT');
  END IF;
  -- the declaration is approved per the existing rules (approve_declaration_extraction): its latest approval
  SELECT * INTO a FROM public.declaration_approvals x WHERE x.transaction_id = v_tx.id ORDER BY x.approved_at DESC, x.id DESC LIMIT 1;
  IF a.id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_approval'); END IF;
  -- … and still in force: its declaration is not cancelled / replaced and its reading not voided since (a new declaration
  -- is read + approved again, which makes a newer approval)
  IF NOT EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.id = a.declaration_id AND d.status NOT IN ('cancelled','replaced'))
     OR NOT EXISTS (SELECT 1 FROM public.document_extractions e WHERE e.id = a.extraction_id AND e.voided_at IS NULL) THEN
    PERFORM app.fail('MRS_REQUIRED', 'declaration_approval');
  END IF;
  -- the three-way match of this transaction on that declaration reading
  SELECT * INTO m FROM public.document_matches x WHERE x.id = v_match AND x.org_id = v_tx.org_id FOR SHARE;
  IF m.id IS NULL OR m.transaction_id IS DISTINCT FROM v_tx.id OR m.voided_at IS NOT NULL OR m.mode <> 'three_way'
     OR m.declaration_extraction_id IS DISTINCT FROM a.extraction_id OR m.engine_version NOT IN ('match-v1','match-v2')
     OR NOT EXISTS (SELECT 1 FROM public.document_extractions e WHERE e.id = m.invoice_extraction_id AND e.transaction_id = v_tx.id AND e.voided_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.document_extractions e WHERE e.id = m.bl_extraction_id AND e.transaction_id = v_tx.id AND e.voided_at IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', 'match_id');
  END IF;
  v_note := app.ptext(p, 'note', 1000);   -- trimmed, control characters removed, ≤ 1000 (MRS_TOO_LONG note)
  v_clean := m.overall = 'match' AND m.mismatch_count = 0 AND m.missing_count = 0;
  IF NOT v_clean AND (NOT coalesce(app.pbool(p, 'confirm_mismatch'), false) OR v_note IS NULL) THEN
    PERFORM app.fail('MRS_TX_MATCH_MISMATCH', m.overall);
  END IF;
  UPDATE public.transactions t SET is_draft = false, approved_at = now(), approved_by = auth.uid(), approval_match_id = m.id,
         approval_note = v_note
   WHERE t.id = v_tx.id RETURNING * INTO v_tx;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'tx_approval', v_tx.operational_status, true, auth.uid(), jsonb_build_object(
    'match_id', m.id, 'overall', m.overall, 'counts', jsonb_build_object('match', m.match_count, 'mismatch', m.mismatch_count,
    'partial', m.partial_count, 'missing', m.missing_count), 'declaration_id', a.declaration_id, 'confirmed_mismatch', NOT v_clean));
  v_res := app.tx_approval_json(v_tx.id) || jsonb_build_object('confirmed_mismatch', NOT v_clean);
  PERFORM app.idem_finish('approve_transaction', v_key, v_res);
  RETURN v_res;
END $$;

-- get_transaction_approval(p_tx) — staff of the transaction's branch → {transaction_id, ref, is_draft, approved_at, approved_by,
-- approved_by_name, approval_match_id, approval_note, cancelled, operational_status, has_declaration, declaration_approval |
-- null, last_three_way_match | null}
CREATE OR REPLACE FUNCTION public.get_transaction_approval(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NULL OR NOT app.has_tx_role(p_tx, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  RETURN app.tx_approval_json(p_tx);
END $$;

COMMENT ON FUNCTION public.create_draft_transaction(uuid, jsonb) IS 'Draft transaction from a draft doc batch (B/L + invoice readings of the ocr.html matching report) through approve_doc_batch; B/L / container rules of the new-transaction form enforced server-side (20261127000100).';
COMMENT ON FUNCTION public.approve_transaction(uuid, jsonb) IS 'Approves a draft transaction after its customs declaration is approved and a three-way match on that declaration reading is saved; mismatches need an explicit confirmation + note (20261127000100).';
COMMENT ON FUNCTION public.get_transaction_approval(uuid) IS 'Draft / approval state of a transaction for the transaction page (20261127000100).';

-- ---------------------------------------------------------------------
-- 6. privileges
-- ---------------------------------------------------------------------
-- the JSON helper: called by SECURITY DEFINER code only (app.tg_transactions_created keeps its ACL of 20261031000300)
REVOKE EXECUTE ON FUNCTION app.tx_approval_json(uuid) FROM PUBLIC, anon, authenticated, service_role;
-- the invoker guard runs as the caller (like app.tg_transactions_legacy_guard, 20261117000100)
REVOKE EXECUTE ON FUNCTION app.tg_transactions_draft_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tg_transactions_draft_guard() TO authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.create_draft_transaction(uuid, jsonb), public.approve_transaction(uuid, jsonb),
  public.get_transaction_approval(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_draft_transaction(uuid, jsonb), public.approve_transaction(uuid, jsonb),
  public.get_transaction_approval(uuid) TO authenticated;
