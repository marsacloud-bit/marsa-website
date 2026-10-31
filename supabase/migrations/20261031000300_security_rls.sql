-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0300 — access helpers, guard triggers,
-- append-only enforcement, generic audit trail, RLS + policies, grants.
--
-- Model: every policy is "TO authenticated" and is built on helper functions
-- that read memberships for auth.uid(). anon has NO table access at all; it
-- may only call the narrow SECURITY DEFINER RPCs granted in 0400.
--
-- FORCE ROW LEVEL SECURITY is intentionally NOT used: the SECURITY DEFINER
-- RPCs/triggers run as the table owner and must write regardless of the
-- caller (e.g. anon intake, audit rows). The owner role is never exposed
-- through the API, so ENABLE (not FORCE) is the right setting here.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Access helpers (SECURITY DEFINER → no RLS recursion on memberships)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active)
$$;

CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles))
$$;

CREATE OR REPLACE FUNCTION app.is_staff(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.has_role(p_org, app.staff_roles())
$$;

-- role valid for this branch: org-wide membership (branch_id NULL) or same branch
CREATE OR REPLACE FUNCTION app.has_branch_role(p_org uuid, p_branch uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
      AND (m.branch_id IS NULL OR m.branch_id = p_branch))
$$;

CREATE OR REPLACE FUNCTION app.my_client_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT cu.client_id FROM public.client_users cu
  JOIN public.clients c ON c.id = cu.client_id AND c.is_active
  WHERE cu.user_id = auth.uid() AND cu.is_active
$$;

CREATE OR REPLACE FUNCTION app.is_client_user(p_client uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_client IS NOT NULL AND EXISTS (SELECT 1 FROM app.my_client_ids() x WHERE x = p_client)
$$;

CREATE OR REPLACE FUNCTION app.has_tx_role(p_tx uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transactions t
                 WHERE t.id = p_tx AND app.has_branch_role(t.org_id, t.branch_id, p_roles))
$$;

CREATE OR REPLACE FUNCTION app.is_tx_client(p_tx uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = p_tx AND app.is_client_user(t.client_id))
$$;

CREATE OR REPLACE FUNCTION app.can_read_transaction(p_tx uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.has_tx_role(p_tx, app.staff_roles()) OR app.is_tx_client(p_tx)
$$;

-- staff of the request's org with one of p_roles (and branch, when assigned)
CREATE OR REPLACE FUNCTION app.has_request_role(p_req uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.service_requests r
                 WHERE r.id = p_req
                   AND (CASE WHEN r.branch_id IS NULL THEN app.has_role(r.org_id, p_roles)
                             ELSE app.has_branch_role(r.org_id, r.branch_id, p_roles) END))
$$;

CREATE OR REPLACE FUNCTION app.is_request_owner(p_req uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.service_requests r
                 WHERE r.id = p_req
                   AND ((r.submitted_by IS NOT NULL AND r.submitted_by = auth.uid())
                        OR app.is_client_user(r.client_id)))
$$;

CREATE OR REPLACE FUNCTION app.can_read_batch(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.import_batches b
                 WHERE b.id = p_batch
                   AND (b.created_by = auth.uid() OR app.has_role(b.org_id, app.ops_writer_roles())))
$$;

CREATE OR REPLACE FUNCTION app.can_edit_batch(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.import_batches b
                 WHERE b.id = p_batch AND b.status = 'draft'
                   AND (b.created_by = auth.uid() OR app.has_role(b.org_id, app.ops_writer_roles())))
$$;

-- staff may see the profile of users who belong to an org where they are staff
CREATE OR REPLACE FUNCTION app.can_see_profile(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_user = auth.uid() OR EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = p_user AND app.is_staff(m.org_id)
    UNION ALL
    SELECT 1 FROM public.client_users cu
    WHERE cu.user_id = p_user AND app.is_staff(cu.org_id))
$$;

-- ---------------------------------------------------------------------
-- 2. Error helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fail(p_code text, p_detail text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = coalesce(p_detail, '');
END $$;

-- ---------------------------------------------------------------------
-- 2b. Reference numbers for API-inserted rows. app.next_ref() itself is NOT
--     executable by authenticated (it would bump any tenant's counters);
--     invoker triggers call this wrapper, which only serves staff of p_org.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.next_ref_checked(p_org uuid, p_scope text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- not staff of p_org → no number and no counter bump; the NOT NULL / RLS check then refuses the row
  IF auth.uid() IS NOT NULL AND NOT app.is_staff(p_org) THEN RETURN NULL; END IF;
  IF p_scope NOT IN ('transaction','import') THEN PERFORM app.fail('MRS_INVALID', 'scope'); END IF;
  RETURN app.next_ref(p_org, p_scope);
END $$;

-- ---------------------------------------------------------------------
-- 3. Guard triggers (direct API writes may only touch safe columns;
--    status/ref/tenant changes go through the RPCs in 0400)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_immutable(p_old jsonb, p_new jsonb, p_cols text[]) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY p_cols LOOP
    IF (p_old -> c) IS DISTINCT FROM (p_new -> c) THEN
      PERFORM app.fail('MRS_IMMUTABLE', c);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.tg_guard_generic() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- TG_ARGV = immutable columns for API callers
  IF app.is_api_caller() THEN
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV::text[]);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard ON public.profiles;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.organizations;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id','slug','environment','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.branches;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id','org_id','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.memberships;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id','user_id','org_id','created_by','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.clients;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id','org_id','created_by','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.client_users;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.client_users FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id','org_id','client_id','user_id','created_by','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.service_requests;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.service_requests FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic(
  'id','org_id','ref','status','source','import_row_id','submitted_by','tracking_token_hash','reviewed_by','reviewed_at','status_note','terms_accepted_at','created_at');
DROP TRIGGER IF EXISTS trg_guard ON public.contact_messages;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.contact_messages FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic(
  'id','org_id','ref','name','company','phone','email','subject','reference','message','preferred','submitted_by','created_at');

-- created_by / inserted-by stamping for API inserts
CREATE OR REPLACE FUNCTION app.tg_stamp_creator() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stamp ON public.memberships;
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.memberships FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();
DROP TRIGGER IF EXISTS trg_stamp ON public.clients;
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.clients FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();
DROP TRIGGER IF EXISTS trg_stamp ON public.client_users;
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.client_users FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();

-- contact messages: stamp handler
CREATE OR REPLACE FUNCTION app.tg_contact_handled() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.handled_by := auth.uid();
    NEW.handled_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_handled ON public.contact_messages;
CREATE TRIGGER trg_handled BEFORE UPDATE ON public.contact_messages FOR EACH ROW EXECUTE FUNCTION app.tg_contact_handled();

-- transactions: server-side ref, initial status, immutables, created event
CREATE OR REPLACE FUNCTION app.tg_transactions_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.is_api_caller() THEN
      NEW.ref := NULL;
      NEW.operational_status := 'new';
      NEW.financial_status := 'not_started';
      NEW.tracking_token_hash := NULL;
      NEW.request_id := NULL;               -- conversion goes through convert_request_to_transaction()
      NEW.created_by := auth.uid();
    END IF;
    IF NEW.ref IS NULL THEN
      NEW.ref := app.next_ref_checked(NEW.org_id, 'transaction');
    END IF;
    NEW.status_changed_at := now();
  ELSE
    IF app.is_api_caller() THEN
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
        'id','org_id','ref','request_id','operational_status','financial_status','status_changed_at',
        'tracking_token_hash','created_by','created_at']);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.transactions;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_before();

CREATE OR REPLACE FUNCTION app.tg_transactions_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, to_status, visible_to_client, actor, payload)
  VALUES (NEW.org_id, NEW.id, 'created', NEW.operational_status, true, auth.uid(), jsonb_build_object('ref', NEW.ref));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_created ON public.transactions;
CREATE TRIGGER trg_created AFTER INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_created();

-- documents: originals immutable; only classification / visibility / void may change
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_documents_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_prev public.documents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.is_api_caller() THEN
      NEW.uploaded_by := auth.uid();
      NEW.uploaded_at := now();
      NEW.classification := NULL;
      NEW.classification_status := 'unreviewed';
      NEW.classified_by := NULL;
      NEW.classified_at := NULL;
      NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
      IF NEW.source IN ('system') THEN NEW.source := 'upload'; END IF;
      -- clients / requesters: the uploader always sees their own file, provenance is "upload"
      IF NOT app.is_staff(NEW.org_id) THEN
        NEW.visibility := 'client';
        NEW.source := 'upload';
        NEW.source_ref := NULL;
      END IF;
    END IF;
    NEW.version := 1;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO v_prev FROM public.documents d WHERE d.id = NEW.supersedes_id;
      IF v_prev.id IS NULL OR v_prev.org_id <> NEW.org_id
         OR v_prev.transaction_id IS DISTINCT FROM NEW.transaction_id
         OR (NEW.transaction_id IS NULL AND v_prev.request_id IS DISTINCT FROM NEW.request_id) THEN
        PERFORM app.fail('MRS_INVALID', 'supersedes_id');
      END IF;
      NEW.version := v_prev.version + 1;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF app.is_api_caller() THEN
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
      'id','org_id','transaction_id','request_id','kind','storage_bucket','storage_path','sha256','original_name',
      'mime_type','size_bytes','version','supersedes_id','source','source_ref','uploaded_by','uploaded_at']);
    IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS NULL OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
      PERFORM app.fail('MRS_IMMUTABLE', 'voided_at');
    END IF;
  END IF;
  IF NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.classification_status IS DISTINCT FROM OLD.classification_status THEN
    NEW.classified_by := auth.uid();
    NEW.classified_at := now();
  END IF;
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    NEW.voided_by := auth.uid();
    NEW.voided_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.documents;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.tg_documents_before();

CREATE OR REPLACE FUNCTION app.tg_documents_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.transaction_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.transaction_id IS NULL
       OR NEW.classification IS DISTINCT FROM OLD.classification OR NEW.voided_at IS DISTINCT FROM OLD.voided_at) THEN
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
    VALUES (NEW.org_id, NEW.transaction_id, 'document', auth.uid(),
            jsonb_build_object('document_id', NEW.id, 'op', lower(TG_OP), 'kind', NEW.kind,
                               'classification', NEW.classification, 'voided', NEW.voided_at IS NOT NULL));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_event ON public.documents;
CREATE TRIGGER trg_event AFTER INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.tg_documents_event();

-- containers: per-container empty-return evidence rule (G0-004, EV-01/02, D-09)
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_containers_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_doc public.documents;
BEGIN
  IF TG_OP = 'UPDATE' AND app.is_api_caller() THEN
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','transaction_id','created_at']);
  END IF;
  NEW.container_no := upper(regexp_replace(NEW.container_no, '[[:space:]-]', '', 'g'));

  -- a waiver counts as "returned" for operational completion → senior roles only, with a reason
  IF app.is_api_caller() AND NEW.return_status = 'waived'
     AND (TG_OP = 'INSERT' OR OLD.return_status IS DISTINCT FROM 'waived') THEN
    IF NOT app.has_tx_role(NEW.transaction_id, ARRAY['operations_manager','supervisor','admin']) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'waiver');
    END IF;
    IF nullif(btrim(coalesce(NEW.waiver_reason, '')), '') IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'waiver_reason'); END IF;
  END IF;

  IF NEW.evidence_document_id IS NOT NULL THEN
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = NEW.evidence_document_id;
    IF v_doc.id IS NULL OR v_doc.transaction_id IS DISTINCT FROM NEW.transaction_id OR v_doc.voided_at IS NOT NULL THEN
      PERFORM app.fail('MRS_EVIDENCE_INVALID', 'evidence_document_id');
    END IF;
  END IF;

  IF NEW.return_status = 'returned_verified'
     AND (TG_OP = 'INSERT' OR OLD.return_status IS DISTINCT FROM 'returned_verified'
          OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    -- only a staff-confirmed EMPTY RETURN RECEIPT proves return. EIR / return note / carrier message never do.
    IF v_doc.id IS NULL OR v_doc.classification IS DISTINCT FROM 'empty_return_receipt'
       OR v_doc.classification_status NOT IN ('confirmed','reclassified') THEN
      PERFORM app.fail('MRS_EVIDENCE_INVALID', 'empty_return_receipt_required');
    END IF;
    NEW.verified_by := coalesce(auth.uid(), NEW.verified_by);
    NEW.verified_at := now();
    NEW.returned_at := coalesce(NEW.returned_at, now());
  END IF;
  IF NEW.return_status <> 'returned_verified' AND TG_OP = 'UPDATE' AND OLD.return_status = 'returned_verified' THEN
    -- un-verifying is a correction: keep evidence, clear the verification stamp (history stays in events/audit)
    NEW.verified_by := NULL;
    NEW.verified_at := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.containers;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION app.tg_containers_before();

CREATE OR REPLACE FUNCTION app.tg_containers_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.return_status IS DISTINCT FROM OLD.return_status THEN
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
    VALUES (NEW.org_id, NEW.transaction_id, 'container_return',
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.return_status END, NEW.return_status,
            NEW.return_status IN ('returned_verified'), auth.uid(),
            jsonb_build_object('container_id', NEW.id, 'container_no', NEW.container_no,
                               'evidence_document_id', NEW.evidence_document_id));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_event ON public.containers;
CREATE TRIGGER trg_event AFTER INSERT OR UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION app.tg_containers_event();

-- import batches / rows
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_import_batches_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.is_api_caller() THEN
      NEW.created_by := auth.uid();
      NEW.status := 'draft';
      NEW.committed_rows := 0; NEW.skipped_rows := 0;
      NEW.committed_by := NULL; NEW.committed_at := NULL;
    END IF;
    NEW.ref := coalesce(NEW.ref, app.next_ref_checked(NEW.org_id, 'import'));
  ELSIF app.is_api_caller() THEN
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
      'id','org_id','ref','client_id','kind','file_fingerprint','created_by','created_at',
      'committed_rows','skipped_rows','committed_by','committed_at']);
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'draft' AND NEW.status = 'cancelled') THEN
      PERFORM app.fail('MRS_BAD_TRANSITION', 'status');
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.import_batches;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.tg_import_batches_before();

-- cancelled draft → its rows stop holding the unique source ids (rows are kept, never deleted)
CREATE OR REPLACE FUNCTION app.tg_import_batches_cancelled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.import_rows x SET is_live = false WHERE x.batch_id = NEW.id AND x.is_live;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_cancelled ON public.import_batches;
CREATE TRIGGER trg_cancelled AFTER UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.tg_import_batches_cancelled();

-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_import_rows_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_batch public.import_batches;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_batch FROM public.import_batches b WHERE b.id = NEW.batch_id;
    IF v_batch.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'batch'); END IF;
    NEW.org_id := v_batch.org_id;
    NEW.source_fingerprint := v_batch.file_fingerprint;   -- source id is always derived from the batch file
    IF app.is_api_caller() THEN
      NEW.corrections := '[]'::jsonb;
      IF NEW.row_status NOT IN ('pending','valid','error') THEN NEW.row_status := 'pending'; END IF;
      NEW.duplicate_of := NULL;
      NEW.is_live := true;
    END IF;
    IF v_batch.status <> 'draft' AND app.is_api_caller() THEN PERFORM app.fail('MRS_BATCH_NOT_DRAFT'); END IF;
    RETURN NEW;
  END IF;
  IF app.is_api_caller() THEN
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
      'id','org_id','batch_id','source_fingerprint','sheet_name','row_no','raw','corrections','duplicate_of','is_live','created_at']);
    IF NEW.row_status IN ('committed','skipped','duplicate') AND NEW.row_status IS DISTINCT FROM OLD.row_status THEN
      PERFORM app.fail('MRS_BAD_TRANSITION', 'row_status');
    END IF;
    IF OLD.row_status IN ('committed','skipped') THEN PERFORM app.fail('MRS_IMMUTABLE', 'row_status'); END IF;
  END IF;
  IF NEW.normalized IS DISTINCT FROM OLD.normalized THEN
    NEW.corrections := OLD.corrections || jsonb_build_array(jsonb_build_object(
      'at', now(), 'by', auth.uid(), 'before', OLD.normalized, 'after', NEW.normalized));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.import_rows;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.import_rows FOR EACH ROW EXECUTE FUNCTION app.tg_import_rows_before();

-- ---------------------------------------------------------------------
-- 4. Append-only enforcement (no UPDATE/DELETE/TRUNCATE for anyone)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS trg_append_only ON public.transaction_events;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.transaction_events FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
DROP TRIGGER IF EXISTS trg_append_only_trunc ON public.transaction_events;
CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON public.transaction_events FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();
DROP TRIGGER IF EXISTS trg_append_only ON public.audit_log;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
DROP TRIGGER IF EXISTS trg_append_only_trunc ON public.audit_log;
CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();

-- events inserted by API callers: notes only, stamped with the caller
CREATE OR REPLACE FUNCTION app.tg_events_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF NEW.event_type <> 'note' THEN PERFORM app.fail('MRS_FORBIDDEN', 'event_type'); END IF;
    NEW.actor := auth.uid();
    NEW.created_at := now();
    NEW.from_status := NULL; NEW.to_status := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.transaction_events;
CREATE TRIGGER trg_before BEFORE INSERT ON public.transaction_events FOR EACH ROW EXECUTE FUNCTION app.tg_events_before();

-- ---------------------------------------------------------------------
-- 5. Generic audit trail
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_org uuid;
BEGIN
  -- never copy secrets into the trail
  v_old := v_old - 'tracking_token_hash';
  v_new := v_new - 'tracking_token_hash';
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) k
    WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k <> 'updated_at';
    IF v_changed IS NULL THEN RETURN NULL; END IF;   -- no-op update
  END IF;
  v_org := CASE WHEN TG_TABLE_NAME = 'organizations' THEN (v_row ->> 'id')::uuid
                ELSE nullif(v_row ->> 'org_id', '')::uuid END;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (v_org, TG_TABLE_NAME, v_row ->> 'id', TG_OP, v_changed, v_old, v_new, auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','branches','memberships','clients','client_users','service_requests',
                           'transactions','containers','documents','import_batches','contact_messages']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','branches','profiles','memberships','org_counters','status_labels',
                           'clients','client_users','import_batches','import_rows','service_requests','transactions',
                           'documents','containers','transaction_events','contact_messages','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- defense in depth: visitors never touch tables directly
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated', t);
    -- drop old policies so the file can be re-run
    PERFORM 1;
  END LOOP;
END $$;

-- helper to drop a policy idempotently
CREATE OR REPLACE FUNCTION app.drop_policies(p_table text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = p_table LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, p_table);
  END LOOP;
END $$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['organizations','branches','profiles','memberships','org_counters',
  'status_labels','clients','client_users','import_batches','import_rows','service_requests','transactions',
  'documents','containers','transaction_events','contact_messages','audit_log']) t;

-- status_labels: public dictionary (no personal data)
GRANT SELECT ON public.status_labels TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.status_labels FROM authenticated;
CREATE POLICY status_labels_read ON public.status_labels FOR SELECT TO anon, authenticated USING (true);

-- org_counters: no direct access (only app.next_ref)
REVOKE ALL ON public.org_counters FROM authenticated;

-- organizations
CREATE POLICY org_select ON public.organizations FOR SELECT TO authenticated USING (app.is_member(id));
CREATE POLICY org_update ON public.organizations FOR UPDATE TO authenticated
  USING (app.has_role(id, ARRAY['admin'])) WITH CHECK (app.has_role(id, ARRAY['admin']));

-- branches
CREATE POLICY branches_select ON public.branches FOR SELECT TO authenticated USING (app.is_member(org_id));
CREATE POLICY branches_insert ON public.branches FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, ARRAY['admin']));
CREATE POLICY branches_update ON public.branches FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['admin'])) WITH CHECK (app.has_role(org_id, ARRAY['admin']));

-- profiles
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (app.can_see_profile(id));
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- memberships (admin-managed; users see their own)
CREATE POLICY memberships_select ON public.memberships FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR app.has_role(org_id, ARRAY['admin','supervisor']));
-- no INSERT/UPDATE/DELETE for API roles: role changes go through admin_add_member /
-- admin_set_member_active (0650), which refuse self-changes and removing the last admin.
REVOKE INSERT, UPDATE, DELETE ON public.memberships FROM authenticated;

-- clients (org-wide master; branch ownership is an open owner decision)
CREATE POLICY clients_select ON public.clients FOR SELECT TO authenticated
  USING (app.is_staff(org_id) OR app.is_client_user(id));
CREATE POLICY clients_insert ON public.clients FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, app.ops_writer_roles()));
CREATE POLICY clients_update ON public.clients FOR UPDATE TO authenticated
  USING (app.has_role(org_id, app.ops_writer_roles())) WITH CHECK (app.has_role(org_id, app.ops_writer_roles()));

-- client_users
CREATE POLICY client_users_select ON public.client_users FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR app.is_staff(org_id));
CREATE POLICY client_users_insert ON public.client_users FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['operations_manager','supervisor','admin']));
CREATE POLICY client_users_update ON public.client_users FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['operations_manager','supervisor','admin']))
  WITH CHECK (app.has_role(org_id, ARRAY['operations_manager','supervisor','admin']));

-- service_requests (insert only via submit_service_request / import_commit)
CREATE POLICY requests_select ON public.service_requests FOR SELECT TO authenticated
  USING ( (CASE WHEN branch_id IS NULL THEN app.has_role(org_id, app.ops_writer_roles())
                ELSE app.has_branch_role(org_id, branch_id, app.ops_writer_roles()) END)
          OR (submitted_by IS NOT NULL AND submitted_by = auth.uid())
          OR app.is_client_user(client_id) );
CREATE POLICY requests_update ON public.service_requests FOR UPDATE TO authenticated
  USING (CASE WHEN branch_id IS NULL THEN app.has_role(org_id, app.ops_writer_roles())
              ELSE app.has_branch_role(org_id, branch_id, app.ops_writer_roles()) END)
  WITH CHECK (CASE WHEN branch_id IS NULL THEN app.has_role(org_id, app.ops_writer_roles())
                   ELSE app.has_branch_role(org_id, branch_id, app.ops_writer_roles()) END);

-- transactions (branch-isolated for staff; clients see their own)
CREATE POLICY transactions_select ON public.transactions FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.staff_roles()) OR app.is_client_user(client_id));
CREATE POLICY transactions_insert ON public.transactions FOR INSERT TO authenticated
  WITH CHECK (app.has_branch_role(org_id, branch_id, app.ops_writer_roles()));
CREATE POLICY transactions_update ON public.transactions FOR UPDATE TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.ops_writer_roles()))
  WITH CHECK (app.has_branch_role(org_id, branch_id, app.ops_writer_roles()));

-- containers
CREATE POLICY containers_select ON public.containers FOR SELECT TO authenticated
  USING (app.can_read_transaction(transaction_id));
CREATE POLICY containers_insert ON public.containers FOR INSERT TO authenticated
  WITH CHECK (app.has_tx_role(transaction_id, app.transport_writer_roles()));
CREATE POLICY containers_update ON public.containers FOR UPDATE TO authenticated
  USING (app.has_tx_role(transaction_id, app.transport_writer_roles()))
  WITH CHECK (app.has_tx_role(transaction_id, app.transport_writer_roles()));

-- documents (no DELETE: void instead)
CREATE POLICY documents_select ON public.documents FOR SELECT TO authenticated
  USING (
    -- own uploads only while the uploader still belongs there (an off-boarded employee loses access)
    (uploaded_by = auth.uid() AND (app.is_member(org_id) OR app.is_request_owner(request_id) OR app.is_tx_client(transaction_id)))
    OR (transaction_id IS NOT NULL AND app.has_tx_role(transaction_id, app.staff_roles()))
    OR (transaction_id IS NULL AND app.has_request_role(request_id, app.ops_writer_roles()))
    OR (transaction_id IS NOT NULL AND visibility = 'client' AND voided_at IS NULL AND app.is_tx_client(transaction_id))
  );
CREATE POLICY documents_insert ON public.documents FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid() AND (
      (transaction_id IS NOT NULL AND (app.has_tx_role(transaction_id, app.staff_roles()) OR app.is_tx_client(transaction_id)))
      OR (transaction_id IS NULL AND (app.has_request_role(request_id, app.ops_writer_roles()) OR app.is_request_owner(request_id)))
    ));
CREATE POLICY documents_update ON public.documents FOR UPDATE TO authenticated
  USING ( (transaction_id IS NOT NULL AND app.has_tx_role(transaction_id, app.staff_roles()))
          OR (transaction_id IS NULL AND app.has_request_role(request_id, app.ops_writer_roles())) )
  WITH CHECK ( (transaction_id IS NOT NULL AND app.has_tx_role(transaction_id, app.staff_roles()))
          OR (transaction_id IS NULL AND app.has_request_role(request_id, app.ops_writer_roles())) );

-- transaction_events (append-only: no UPDATE/DELETE policies at all)
CREATE POLICY events_select ON public.transaction_events FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles())
         OR (visible_to_client AND app.is_tx_client(transaction_id)));
CREATE POLICY events_insert_note ON public.transaction_events FOR INSERT TO authenticated
  WITH CHECK (event_type = 'note' AND app.has_tx_role(transaction_id, app.staff_roles()));
REVOKE UPDATE, DELETE ON public.transaction_events FROM authenticated;

-- import staging
CREATE POLICY import_batches_select ON public.import_batches FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR app.has_role(org_id, app.ops_writer_roles()));
CREATE POLICY import_batches_insert ON public.import_batches FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, app.ops_writer_roles()));
CREATE POLICY import_batches_update ON public.import_batches FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR app.has_role(org_id, app.ops_writer_roles()))
  WITH CHECK (created_by = auth.uid() OR app.has_role(org_id, app.ops_writer_roles()));
CREATE POLICY import_rows_select ON public.import_rows FOR SELECT TO authenticated USING (app.can_read_batch(batch_id));
CREATE POLICY import_rows_insert ON public.import_rows FOR INSERT TO authenticated WITH CHECK (app.can_edit_batch(batch_id));
CREATE POLICY import_rows_update ON public.import_rows FOR UPDATE TO authenticated
  USING (app.can_edit_batch(batch_id)) WITH CHECK (app.can_edit_batch(batch_id));

-- contact messages (insert only via submit_contact_message)
CREATE POLICY contact_select ON public.contact_messages FOR SELECT TO authenticated
  USING (app.has_role(org_id, ARRAY['clearance_staff','operations_manager','supervisor','admin']));
CREATE POLICY contact_update ON public.contact_messages FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['clearance_staff','operations_manager','supervisor','admin']))
  WITH CHECK (app.has_role(org_id, ARRAY['clearance_staff','operations_manager','supervisor','admin']));

-- audit log (read-only for admin/supervisor)
CREATE POLICY audit_select ON public.audit_log FOR SELECT TO authenticated
  USING (org_id IS NOT NULL AND app.has_role(org_id, ARRAY['admin','supervisor']));
REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM authenticated;

-- ---------------------------------------------------------------------
-- 7. Function privileges: nothing in app.* is callable by default.
--    Policy helpers must be executable by authenticated (policies run as caller).
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', r.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  app.all_roles(), app.staff_roles(), app.ops_writer_roles(), app.transport_writer_roles(), app.finance_roles(),
  app.document_kinds(), app.is_api_caller(),
  app.is_member(uuid), app.has_role(uuid, text[]), app.is_staff(uuid), app.has_branch_role(uuid, uuid, text[]),
  app.my_client_ids(), app.is_client_user(uuid), app.has_tx_role(uuid, text[]), app.is_tx_client(uuid),
  app.can_read_transaction(uuid), app.has_request_role(uuid, text[]), app.is_request_owner(uuid),
  app.can_read_batch(uuid), app.can_edit_batch(uuid), app.can_see_profile(uuid),
  app.fail(text, text), app.guard_immutable(jsonb, jsonb, text[]),
  -- used by invoker triggers (refs for API-inserted transactions / import batches); checks staff of p_org.
  -- The app schema must NOT be added to the API's exposed schemas.
  app.next_ref_checked(uuid, text)
TO authenticated;
