-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261102000200 — G2.3–G2.8 organizations,
-- branches, invitations, roles (docs/online/G2_SPEC.md).
--
-- 1. New role branch_manager (always tied to ONE branch). Everywhere
--    operations_manager is allowed, branch_manager is allowed too, limited
--    to its branch by app.has_branch_role(). The functions / policies that
--    hard-code operations_manager are recreated below with the same
--    signatures and bodies (only the role lists change).
-- 2. Membership CHECKs: admin is org-wide (branch_id NULL), branch_manager
--    needs a branch.
-- 3. Platform admins (public.platform_admins, rows via SQL Editor only:
--    supabase/make_platform_admin.sql). They manage organizations only and get
--    NO implicit read of tenant data (they are not members).
-- 4. Org settings / branches through RPCs only (whitelisted fields, branch
--    code immutable, last active branch guard). Direct API writes on
--    organizations / branches are closed.
-- 5. Invitations (token returned once, only SHA-256 stored; e-mail must match a
--    confirmed account at accept time; no look-up of auth.users at invite time,
--    so no account-existence oracle). admin_add_member is no longer callable
--    from the API.
-- 6. Review fixes (G2 security review): suspension / deactivation really cut
--    access (inactive org → no client-portal access, no public tracking;
--    inactive branch → its branch-scoped memberships stop counting; a
--    deactivated 'client' membership ends its portal links); a branch manager
--    can neither link client_users directly nor invite itself, and invites
--    client-portal users only for clients wholly inside its branch(es); an
--    invitation works only while its inviter still holds that authority;
--    serialized last-admin guard; platform_admins audited;
--    platform_reissue_admin_invitation for orgs that lost their first link.
--
-- Errors: MRS_EXPIRED, MRS_EMAIL_MISMATCH, MRS_EMAIL_UNCONFIRMED (new) plus the
-- existing codes. Duplicates use MRS_INVALID with detail slug_taken /
-- code_taken / invitation_pending.
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. roles
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.all_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['client','clearance_staff','transport_staff','accountant','accounts_manager',
               'operations_manager','branch_manager','supervisor','admin']
$$;
CREATE OR REPLACE FUNCTION app.staff_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','accountant','accounts_manager',
               'operations_manager','branch_manager','supervisor','admin']
$$;
-- may create/edit clients, requests, transactions
CREATE OR REPLACE FUNCTION app.ops_writer_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
$$;
-- may edit containers / transport data
CREATE OR REPLACE FUNCTION app.transport_writer_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','operations_manager','branch_manager','supervisor','admin']
$$;
-- roles a branch manager may invite / (de)activate inside its own branch
CREATE OR REPLACE FUNCTION app.bm_managed_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','accountant']
$$;

INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('role','branch_manager',7,'مدير فرع','Branch manager',false),
  ('role','supervisor',8,'مشرف','Supervisor',false),
  ('role','admin',9,'مدير نظام','System admin',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 2. membership scope rules
-- ---------------------------------------------------------------------
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_admin_no_branch;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_admin_no_branch
  CHECK (role <> 'admin' OR branch_id IS NULL);
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_branch_manager_branch;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_branch_manager_branch
  CHECK (role <> 'branch_manager' OR branch_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- 2b. access helpers (bodies from 0300 plus the G2 suspension rules)
--     * a branch-scoped membership counts only while its branch is active
--       (deactivating a branch cuts its members' access; org-wide roles keep theirs)
--     * client-portal access needs an active organization, and ends when the
--       user's 'client' membership in that org was deactivated (legacy
--       client_users links without any client membership keep working)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active
      AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
$$;

CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
      AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))
$$;

-- role valid for this branch: org-wide membership (branch_id NULL) or same (active) branch
CREATE OR REPLACE FUNCTION app.has_branch_role(p_org uuid, p_branch uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
      AND (m.branch_id IS NULL
           OR (m.branch_id = p_branch AND EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active))))
$$;

CREATE OR REPLACE FUNCTION app.my_client_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT cu.client_id FROM public.client_users cu
  JOIN public.clients c ON c.id = cu.client_id AND c.is_active
  JOIN public.organizations o ON o.id = c.org_id AND o.is_active
  WHERE cu.user_id = auth.uid() AND cu.is_active
    AND NOT EXISTS (SELECT 1 FROM public.memberships m
                     WHERE m.user_id = auth.uid() AND m.org_id = c.org_id AND m.role = 'client' AND NOT m.is_active)
$$;

-- Same checks as has_branch_role, for an explicit user (the inviter of an
-- invitation, while auth.uid() is the invitee). p_branch NULL = org-wide only.
CREATE OR REPLACE FUNCTION app.uid_has_branch_role(p_uid uuid, p_org uuid, p_branch uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.memberships m
    JOIN public.organizations o ON o.id = m.org_id AND o.is_active
    WHERE m.user_id = p_uid AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
      AND (m.branch_id IS NULL
           OR (m.branch_id = p_branch AND EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active))))
$$;

-- A client is "in the branch scope" of a branch manager when it has at least one
-- transaction / branch-assigned request and ALL of them sit in branches that user
-- manages. Clients are org-wide, so this is what keeps a branch manager's
-- client-portal invitations from opening another branch's transactions.
CREATE OR REPLACE FUNCTION app.bm_client_in_scope(p_uid uuid, p_org uuid, p_client uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH br AS (
    SELECT t.branch_id FROM public.transactions t WHERE t.org_id = p_org AND t.client_id = p_client
    UNION
    SELECT r.branch_id FROM public.service_requests r
     WHERE r.org_id = p_org AND r.client_id = p_client AND r.branch_id IS NOT NULL)
  SELECT EXISTS (SELECT 1 FROM br)
     AND NOT EXISTS (SELECT 1 FROM br WHERE NOT app.uid_has_branch_role(p_uid, p_org, br.branch_id, ARRAY['branch_manager']))
$$;

-- ---------------------------------------------------------------------
-- 3. recreated with branch_manager next to operations_manager
--    (bodies otherwise identical to 0300 / 0400)
-- ---------------------------------------------------------------------
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
    IF NOT app.has_tx_role(NEW.transaction_id, ARRAY['operations_manager','branch_manager','supervisor','admin']) THEN
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

-- client_users: same roles as 0300 — NOT branch_manager. A portal link opens every
-- transaction of the client in every branch, so a branch manager may only create
-- links through admin_invite (client in its branch scope) + accept_invitation.
DROP POLICY IF EXISTS client_users_insert ON public.client_users;
DROP POLICY IF EXISTS client_users_update ON public.client_users;
CREATE POLICY client_users_insert ON public.client_users FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['operations_manager','supervisor','admin']));
CREATE POLICY client_users_update ON public.client_users FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['operations_manager','supervisor','admin']))
  WITH CHECK (app.has_role(org_id, ARRAY['operations_manager','supervisor','admin']));

-- contact messages (org-wide records; branch_manager of any branch, like clearance_staff)
DROP POLICY IF EXISTS contact_select ON public.contact_messages;
DROP POLICY IF EXISTS contact_update ON public.contact_messages;
CREATE POLICY contact_select ON public.contact_messages FOR SELECT TO authenticated
  USING (app.has_role(org_id, ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']));
CREATE POLICY contact_update ON public.contact_messages FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']))
  WITH CHECK (app.has_role(org_id, ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']));

-- set_transaction_status — the ONLY way to move operational_status (signature unchanged)
CREATE OR REPLACE FUNCTION public.set_transaction_status(p_transaction_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_from int; v_to int;
  v_roles text[];
  v_backward boolean;
  v_skip int;
  v_open int;
  v_ev bigint;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_to := app.code_sort('operational_status', p_status);
  v_from := app.code_sort('operational_status', v_tx.operational_status);
  IF v_to IS NULL THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_to = v_from THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  v_backward := v_to < v_from;

  v_roles := CASE p_status
    WHEN 'new'                    THEN ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
    WHEN 'in_progress'            THEN ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
    WHEN 'customs_declaration'    THEN ARRAY['clearance_staff','operations_manager','branch_manager','supervisor','admin']
    WHEN 'appointment'            THEN app.transport_writer_roles()
    WHEN 'transport'              THEN app.transport_writer_roles()
    WHEN 'empty_return'           THEN app.transport_writer_roles()
    WHEN 'operationally_complete' THEN app.ops_writer_roles()
    WHEN 'under_billing'          THEN app.finance_roles()
    WHEN 'billed'                 THEN app.finance_roles()
    WHEN 'closed'                 THEN ARRAY['accounts_manager','supervisor','admin']
  END;
  IF v_backward THEN
    -- corrections never erase history: they add an event and need a reason + senior role
    IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED'); END IF;
    v_roles := CASE WHEN v_tx.operational_status = 'closed' THEN ARRAY['admin']
                    ELSE ARRAY['operations_manager','branch_manager','supervisor','admin'] END;
  END IF;
  -- operational completion needs per-container empty-return proof (or a documented waiver).
  -- Declared containers that were never registered count as "not returned" (no trivial pass with 0 rows).
  IF NOT v_backward AND v_to >= app.code_sort('operational_status', 'operationally_complete') THEN
    SELECT count(*) INTO v_open FROM public.containers c
     WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived');
    v_open := greatest(v_open, coalesce(v_tx.container_count, 0)
                               - (SELECT count(*) FROM public.containers c WHERE c.transaction_id = v_tx.id));
    IF v_open > 0 THEN PERFORM app.fail('MRS_CONTAINERS_NOT_RETURNED', v_open::text); END IF;
  END IF;

  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, v_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;

  -- stage order: forward moves go one stage at a time. The empty-return stage may be passed over
  -- when the transaction has no containers. Any other skip is an exception: senior role + reason.
  IF NOT v_backward AND v_to - v_from > 1 THEN
    v_skip := v_to - v_from - 1;
    IF v_from < app.code_sort('operational_status', 'empty_return') AND v_to > app.code_sort('operational_status', 'empty_return')
       AND coalesce(v_tx.container_count, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = v_tx.id) THEN
      v_skip := v_skip - 1;
    END IF;
    IF v_skip > 0 THEN
      IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, ARRAY['operations_manager','branch_manager','supervisor','admin']) THEN
        PERFORM app.fail('MRS_BAD_TRANSITION', 'stage_skip');
      END IF;
      IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED'); END IF;
    END IF;
  END IF;


  UPDATE public.transactions t SET operational_status = p_status, status_changed_at = now() WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'operational_status', v_tx.operational_status, p_status, true, auth.uid(),
          jsonb_build_object('direction', CASE WHEN v_backward THEN 'backward' ELSE 'forward' END))
  RETURNING id INTO v_ev;
  IF v_note IS NOT NULL THEN
    -- the reason is internal; status events visible to clients carry no free text
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
    VALUES (v_tx.org_id, v_tx.id, 'note', v_note, false, auth.uid(), jsonb_build_object('for_event', v_ev));
  END IF;
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'from', v_tx.operational_status,
                            'to', p_status, 'event_id', v_ev);
END $$;

-- ---------------------------------------------------------------------
-- 4. audit trail: also never copy invitation token hashes
--    (same body as 20261101000100 plus 'token_hash')
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
  v_old := v_old - 'tracking_token_hash' - 'token_hash';
  v_new := v_new - 'tracking_token_hash' - 'token_hash';
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) k
    WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k <> 'updated_at';
    IF v_changed IS NULL THEN RETURN NULL; END IF;   -- no-op update
  END IF;
  -- OCR content stays in document_extractions (branch-scoped RLS), never in the trail
  IF TG_TABLE_NAME = 'document_extractions' THEN
    v_old := v_old - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note'];
    v_new := v_new - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note'];
  END IF;
  v_org := CASE WHEN TG_TABLE_NAME = 'organizations' THEN (v_row ->> 'id')::uuid
                ELSE nullif(v_row ->> 'org_id', '')::uuid END;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  -- tables keyed by user_id (platform_admins) have no id column
  VALUES (v_org, TG_TABLE_NAME, coalesce(v_row ->> 'id', v_row ->> 'user_id'), TG_OP, v_changed, v_old, v_new,
          auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 5. platform admins (rows only via SQL Editor: supabase/make_platform_admin.sql)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  note       text CHECK (char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.platform_admins IS 'G2.7 platform operators (مدير المنصة). Manage organizations only; NOT members of any tenant. Written from the SQL Editor only.';
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_admins FROM anon, authenticated;
-- no policies: API roles never read or write this table directly
-- privilege state: every grant / removal (SQL Editor) leaves an audit row (org_id NULL → service role only)
DROP TRIGGER IF EXISTS trg_audit ON public.platform_admins;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.platform_admins
  FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- 6. organizations / branches: writes through the RPCs below only
--    (whitelist, code immutability and the last-branch guard live there)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS org_update ON public.organizations;
DROP POLICY IF EXISTS branches_insert ON public.branches;
DROP POLICY IF EXISTS branches_update ON public.branches;
REVOKE INSERT, UPDATE, DELETE ON public.organizations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.branches FROM authenticated;

-- ---------------------------------------------------------------------
-- 7. invitations
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  email       text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 160),
  role        text NOT NULL CHECK (role = ANY (app.all_roles())),
  branch_id   uuid,
  client_id   uuid,
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by  uuid,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at  timestamptz,
  revoked_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT invitations_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT invitations_client_shape CHECK (
    CASE WHEN role = 'client' THEN client_id IS NOT NULL AND branch_id IS NULL ELSE client_id IS NULL END),
  CONSTRAINT invitations_admin_no_branch CHECK (role <> 'admin' OR branch_id IS NULL),
  CONSTRAINT invitations_branch_manager_branch CHECK (role <> 'branch_manager' OR branch_id IS NOT NULL),
  CONSTRAINT invitations_final_once CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
COMMENT ON TABLE public.invitations IS 'G2.6 invitations. Token returned once by the RPC; only its SHA-256 is stored. Written only by SECURITY DEFINER RPCs.';
-- one pending invitation per (org, email, role, branch, client)
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_idx ON public.invitations (
  org_id, email, role,
  coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS invitations_org_idx ON public.invitations (org_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_touch ON public.invitations;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.invitations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_audit ON public.invitations;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.invitations FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invitations FROM anon, authenticated;
-- read-only for the API, and never the token hash (column grant, fail closed for new columns).
-- Same rows as admin_list_invitations (app.can_manage_invitation).
GRANT SELECT (id, org_id, email, role, branch_id, client_id, invited_by, expires_at, accepted_at, accepted_by,
              revoked_at, revoked_by, created_at, updated_at) ON public.invitations TO authenticated;
DROP POLICY IF EXISTS invitations_select ON public.invitations;
CREATE POLICY invitations_select ON public.invitations FOR SELECT TO authenticated
  USING (app.has_role(org_id, ARRAY['admin'])
         OR (branch_id IS NOT NULL AND role = ANY (app.bm_managed_roles())
             AND app.has_branch_role(org_id, branch_id, ARRAY['branch_manager']))
         OR (role = 'client' AND invited_by = auth.uid() AND app.has_role(org_id, ARRAY['branch_manager'])));

-- ---------------------------------------------------------------------
-- 8. helpers
-- ---------------------------------------------------------------------
-- 256 random bits as 64 hex chars (invitation + tracking tokens; only the SHA-256
-- is stored). Replaces the 0400 body (two UUIDv4 = 244 random bits with fixed
-- version / variant nibbles): three UUIDv4 (366 random bits) hashed to 256 bits.
-- No pgcrypto needed (gen_random_uuid is core and uses the strong RNG).
CREATE OR REPLACE FUNCTION app.new_token() RETURNS text LANGUAGE sql VOLATILE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex')
$$;

-- admin of the org, or branch_manager of p_branch for the lower staff roles
CREATE OR REPLACE FUNCTION app.can_manage_member(p_org uuid, p_branch uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.has_role(p_org, ARRAY['admin'])
      OR (p_branch IS NOT NULL AND p_role = ANY (app.bm_managed_roles())
          AND app.has_branch_role(p_org, p_branch, ARRAY['branch_manager']))
$$;

-- invitation management: as above, plus client-portal invitations a branch manager issued himself
CREATE OR REPLACE FUNCTION app.can_manage_invitation(p_inv public.invitations) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.can_manage_member(p_inv.org_id, p_inv.branch_id, p_inv.role)
      OR (p_inv.role = 'client' AND p_inv.invited_by = auth.uid() AND app.has_role(p_inv.org_id, ARRAY['branch_manager']))
$$;

-- Is the invitation still backed by its inviter's CURRENT authority? Checked at
-- preview / accept time (and after a member is deactivated), so a removed admin or
-- branch manager cannot leave working links behind. Written against invited_by:
-- at accept time auth.uid() is the invitee.
CREATE OR REPLACE FUNCTION app.invitation_authorized(p_inv public.invitations) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_inv.invited_by IS NOT NULL AND (
       -- first admin of an org created by a platform operator (platform_create_org)
       (p_inv.role = 'admin' AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p_inv.invited_by))
    OR app.uid_has_branch_role(p_inv.invited_by, p_inv.org_id, NULL, ARRAY['admin'])
    OR (p_inv.role = ANY (app.bm_managed_roles()) AND p_inv.branch_id IS NOT NULL
        AND app.uid_has_branch_role(p_inv.invited_by, p_inv.org_id, p_inv.branch_id, ARRAY['branch_manager']))
    OR (p_inv.role = 'client' AND p_inv.client_id IS NOT NULL
        AND app.bm_client_in_scope(p_inv.invited_by, p_inv.org_id, p_inv.client_id)))
$$;

CREATE OR REPLACE FUNCTION app.invitation_status(p_inv public.invitations) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_inv.accepted_at IS NOT NULL THEN 'accepted'
              WHEN p_inv.revoked_at IS NOT NULL THEN 'revoked'
              WHEN p_inv.expires_at <= now() THEN 'expired'
              ELSE 'pending' END
$$;

-- a***@example.com (preview shows which mailbox to use without revealing it)
CREATE OR REPLACE FUNCTION app.mask_email(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR position('@' IN p) < 2 THEN '***'
              ELSE left(p, 1) || '***' || substr(p, position('@' IN p)) END
$$;

-- jsonb payload: refuse unknown keys (the key itself is not echoed)
CREATE OR REPLACE FUNCTION app.only_keys(p jsonb, p_allowed text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k = ANY (p_allowed))) THEN
    PERFORM app.fail('MRS_INVALID', 'unknown_key');
  END IF;
END $$;

-- optional uuid field from a payload (MRS_INVALID <k> when malformed)
CREATE OR REPLACE FUNCTION app.puuid(p jsonb, k text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := nullif(btrim(coalesce(p ->> k, '')), '');
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'string'
     OR v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM app.fail('MRS_INVALID', k);
  END IF;
  RETURN v::uuid;
END $$;

-- branch fields shared by create/update (only keys present in p are returned)
CREATE OR REPLACE FUNCTION app.branch_fields(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; s text;
BEGIN
  IF p ? 'code' THEN
    s := upper(app.ptext(p, 'code', 10, true));
    IF s !~ '^[A-Z0-9]{2,10}$' THEN PERFORM app.fail('MRS_INVALID', 'code'); END IF;
    v := v || jsonb_build_object('code', s);
  END IF;
  IF p ? 'name_ar' THEN
    s := app.ptext(p, 'name_ar', 120, true);
    IF char_length(s) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
    v := v || jsonb_build_object('name_ar', s);
  END IF;
  IF p ? 'name_en' THEN v := v || jsonb_build_object('name_en', app.ptext(p, 'name_en', 120)); END IF;
  IF p ? 'city' THEN v := v || jsonb_build_object('city', app.ptext(p, 'city', 80)); END IF;
  IF p ? 'is_active' THEN
    IF jsonb_typeof(p -> 'is_active') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'is_active'); END IF;
    v := v || jsonb_build_object('is_active', p -> 'is_active');
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.branch_json(p_b public.branches) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', p_b.id, 'org_id', p_b.org_id, 'code', p_b.code, 'name_ar', p_b.name_ar,
                            'name_en', p_b.name_en, 'city', p_b.city, 'is_active', p_b.is_active,
                            'created_at', p_b.created_at, 'updated_at', p_b.updated_at)
$$;

-- creates a pending invitation; returns (id, token). Callers check who may invite what.
CREATE OR REPLACE FUNCTION app.create_invitation(
  p_org uuid, p_email text, p_role text, p_branch uuid, p_client uuid,
  OUT id uuid, OUT token text, OUT expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- an expired pending invitation for the same target no longer blocks a new one
  UPDATE public.invitations i SET revoked_at = now(), revoked_by = auth.uid()
   WHERE i.org_id = p_org AND i.email = p_email AND i.role = p_role
     AND i.branch_id IS NOT DISTINCT FROM p_branch AND i.client_id IS NOT DISTINCT FROM p_client
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at <= now();
  IF EXISTS (SELECT 1 FROM public.invitations i
              WHERE i.org_id = p_org AND i.email = p_email AND i.role = p_role
                AND i.branch_id IS NOT DISTINCT FROM p_branch AND i.client_id IS NOT DISTINCT FROM p_client
                AND i.accepted_at IS NULL AND i.revoked_at IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', 'invitation_pending');
  END IF;
  token := app.new_token();
  INSERT INTO public.invitations (org_id, email, role, branch_id, client_id, token_hash, invited_by)
  VALUES (p_org, p_email, p_role, p_branch, p_client, app.hash_token(token), auth.uid())
  RETURNING invitations.id, invitations.expires_at INTO id, expires_at;
END $$;

-- ---------------------------------------------------------------------
-- 9. platform RPCs (platform admin only)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_list_orgs() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  -- organization metadata and counts only: no tenant operational data
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en, 'ref_prefix', o.ref_prefix,
             'environment', o.environment, 'is_active', o.is_active, 'default_locale', o.default_locale,
             'created_at', o.created_at,
             'branches', (SELECT count(*) FROM public.branches b WHERE b.org_id = o.id AND b.is_active),
             'members', (SELECT count(DISTINCT m.user_id) FROM public.memberships m WHERE m.org_id = o.id AND m.is_active),
             'admins', (SELECT count(*) FROM public.memberships m WHERE m.org_id = o.id AND m.is_active AND m.role = 'admin'),
             -- masked: shows that (and roughly which) admins exist without revealing tenant user identity
             'admin_emails_masked', coalesce((SELECT jsonb_agg(app.mask_email(lower(u.email)) ORDER BY lower(u.email)) FROM public.memberships m
                                         JOIN auth.users u ON u.id = m.user_id
                                        WHERE m.org_id = o.id AND m.is_active AND m.role = 'admin'), '[]'::jsonb),
             'pending_admin_invitations', (SELECT count(*) FROM public.invitations i
                                            WHERE i.org_id = o.id AND i.role = 'admin' AND i.accepted_at IS NULL
                                              AND i.revoked_at IS NULL AND i.expires_at > now()))
           ORDER BY o.created_at, o.slug)
      FROM public.organizations o), '[]'::jsonb);
END $$;

-- payload {slug, name_ar, name_en?, ref_prefix, default_locale?, branch:{code, name_ar, name_en?, city?},
--          admin_email, idempotencyKey}
CREATE OR REPLACE FUNCTION public.platform_create_org(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key    uuid;
  v_replay jsonb;
  v_slug   text;
  v_name   text;
  v_prefix text;
  v_locale text;
  v_email  text;
  v_br     jsonb;
  v_bf     jsonb;
  v_org    uuid;
  v_branch uuid;
  v_inv    record;
  v_res    jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['slug','name_ar','name_en','ref_prefix','default_locale','branch',
                                         'admin_email','idempotencyKey']);
  v_key := app.idem_key_from(p_payload);
  v_replay := app.idem_begin('platform_create_org', v_key, p_payload);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_slug := lower(app.ptext(p_payload, 'slug', 40, true));
  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' THEN PERFORM app.fail('MRS_INVALID', 'slug'); END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = v_slug) THEN PERFORM app.fail('MRS_INVALID', 'slug_taken'); END IF;
  v_name := app.ptext(p_payload, 'name_ar', 160, true);
  IF char_length(v_name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
  v_prefix := upper(app.ptext(p_payload, 'ref_prefix', 5, true));
  IF v_prefix !~ '^[A-Z]{2,5}$' THEN PERFORM app.fail('MRS_INVALID', 'ref_prefix'); END IF;
  v_locale := coalesce(app.ptext(p_payload, 'default_locale', 2), 'ar');
  IF v_locale NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'default_locale'); END IF;
  v_email := lower(app.ptext(p_payload, 'admin_email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'admin_email'); END IF;
  v_br := p_payload -> 'branch';
  IF v_br IS NULL OR jsonb_typeof(v_br) <> 'object' THEN PERFORM app.fail('MRS_REQUIRED', 'branch'); END IF;
  PERFORM app.only_keys(v_br, ARRAY['code','name_ar','name_en','city']);
  IF NOT (v_br ? 'code') THEN PERFORM app.fail('MRS_REQUIRED', 'code'); END IF;
  IF NOT (v_br ? 'name_ar') THEN PERFORM app.fail('MRS_REQUIRED', 'name_ar'); END IF;
  v_bf := app.branch_fields(v_br);

  -- STAGING: environment is forced, never taken from the payload
  INSERT INTO public.organizations (slug, name_ar, name_en, ref_prefix, environment, default_locale, settings)
  VALUES (v_slug, v_name, app.ptext(p_payload, 'name_en', 160), v_prefix, 'staging', v_locale, '{"staging": true}'::jsonb)
  RETURNING id INTO v_org;
  INSERT INTO public.branches (org_id, code, name_ar, name_en, city)
  VALUES (v_org, v_bf ->> 'code', v_bf ->> 'name_ar', v_bf ->> 'name_en', v_bf ->> 'city')
  RETURNING id INTO v_branch;
  SELECT * INTO v_inv FROM app.create_invitation(v_org, v_email, 'admin', NULL, NULL);

  -- the stored replay copy never holds the token
  v_res := jsonb_build_object('org_id', v_org, 'slug', v_slug, 'branch_id', v_branch, 'invitation_id', v_inv.id,
                              'email', v_email, 'expires_at', v_inv.expires_at,
                              'token', NULL, 'accept_path', NULL, 'token_shown', true);
  PERFORM app.idem_finish('platform_create_org', v_key, v_res);
  RETURN v_res || jsonb_build_object('token', v_inv.token, 'accept_path', 'login.html?invite=' || v_inv.token,
                                     'token_shown', false);
END $$;

CREATE OR REPLACE FUNCTION public.platform_set_org_active(p_org uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_o public.organizations;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF p_active IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'status'); END IF;
  SELECT * INTO v_o FROM public.organizations o WHERE o.id = p_org FOR UPDATE;
  IF v_o.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_o.is_active = p_active THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  UPDATE public.organizations o SET is_active = p_active WHERE o.id = v_o.id RETURNING * INTO v_o;
  RETURN jsonb_build_object('org_id', v_o.id, 'slug', v_o.slug, 'is_active', v_o.is_active);
END $$;

-- Recovery when the one-time admin link of a new org was lost (e.g. a replayed
-- platform_create_org returns token:null) or expired: rotates the token of the
-- pending admin invitation that a platform operator created. Only while the org
-- has NO active admin — afterwards the tenant manages its own invitations.
-- Returns the new token once (never stored); no tenant data.
CREATE OR REPLACE FUNCTION public.platform_reissue_admin_invitation(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.invitations; v_token text := app.new_token();
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  -- same lock as the last-admin guard: no admin can appear / disappear meanwhile
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF EXISTS (SELECT 1 FROM public.memberships m WHERE m.org_id = p_org AND m.role = 'admin' AND m.is_active) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'admin_exists');
  END IF;
  SELECT * INTO v_i FROM public.invitations i
   WHERE i.org_id = p_org AND i.role = 'admin' AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = i.invited_by)
   ORDER BY i.created_at DESC LIMIT 1
   FOR UPDATE;
  IF v_i.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  UPDATE public.invitations i
     SET token_hash = app.hash_token(v_token), expires_at = now() + interval '7 days', invited_by = auth.uid()
   WHERE i.id = v_i.id RETURNING * INTO v_i;
  RETURN jsonb_build_object('org_id', v_i.org_id, 'invitation_id', v_i.id, 'email', v_i.email, 'expires_at', v_i.expires_at,
                            'token', v_token, 'accept_path', 'login.html?invite=' || v_token);
END $$;

-- ---------------------------------------------------------------------
-- 10. org admin: organization settings + branches
-- ---------------------------------------------------------------------
-- whitelist: name_ar, name_en, default_locale, public_intake_enabled,
--   settings.{brand_color, contact_phone, contact_email, address_ar, address_en, logo_path}
--   (a settings key set to null / '' is removed; other stored settings keys are kept)
CREATE OR REPLACE FUNCTION public.admin_update_org(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_o   public.organizations;
  v_s   jsonb;
  v_set jsonb;
  k     text;
  v     text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['name_ar','name_en','default_locale','public_intake_enabled','settings']);
  SELECT * INTO v_o FROM public.organizations o WHERE o.id = p_org FOR UPDATE;

  IF p_payload ? 'name_ar' THEN
    v_o.name_ar := app.ptext(p_payload, 'name_ar', 160, true);
    IF char_length(v_o.name_ar) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name_ar'); END IF;
  END IF;
  IF p_payload ? 'name_en' THEN v_o.name_en := app.ptext(p_payload, 'name_en', 160); END IF;
  IF p_payload ? 'default_locale' THEN
    v_o.default_locale := app.ptext(p_payload, 'default_locale', 2, true);
    IF v_o.default_locale NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'default_locale'); END IF;
  END IF;
  IF p_payload ? 'public_intake_enabled' THEN
    IF jsonb_typeof(p_payload -> 'public_intake_enabled') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'public_intake_enabled'); END IF;
    v_o.public_intake_enabled := (p_payload ->> 'public_intake_enabled')::boolean;
  END IF;
  IF p_payload ? 'settings' THEN
    v_s := p_payload -> 'settings';
    PERFORM app.only_keys(v_s, ARRAY['brand_color','contact_phone','contact_email','address_ar','address_en','logo_path']);
    v_set := coalesce(v_o.settings, '{}'::jsonb);
    FOR k IN SELECT jsonb_object_keys(v_s) LOOP
      v := app.ptext(v_s, k, 300);
      IF v IS NULL THEN v_set := v_set - k; CONTINUE; END IF;
      IF k = 'brand_color' THEN
        IF v !~ '^#[0-9A-Fa-f]{6}$' THEN PERFORM app.fail('MRS_INVALID', 'brand_color'); END IF;
        v := lower(v);
      ELSIF k = 'contact_phone' THEN
        v := app.norm_phone(v, true);
        IF v IS NULL THEN PERFORM app.fail('MRS_INVALID', 'contact_phone'); END IF;
      ELSIF k = 'contact_email' THEN
        v := lower(v);
        IF NOT app.is_email(v) THEN PERFORM app.fail('MRS_INVALID', 'contact_email'); END IF;
      ELSIF k IN ('address_ar','address_en') THEN
        IF char_length(v) > 300 THEN PERFORM app.fail('MRS_TOO_LONG', k); END IF;
      ELSIF k = 'logo_path' THEN
        -- a storage object path, never a URL; must live under this org's folder
        IF v !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$' OR position('..' IN v) > 0
           OR split_part(v, '/', 1) <> p_org::text THEN
          PERFORM app.fail('MRS_INVALID', 'logo_path');
        END IF;
      END IF;
      v_set := v_set || jsonb_build_object(k, v);
    END LOOP;
    v_o.settings := v_set;
  END IF;

  UPDATE public.organizations o
     SET name_ar = v_o.name_ar, name_en = v_o.name_en, default_locale = v_o.default_locale,
         public_intake_enabled = v_o.public_intake_enabled, settings = v_o.settings
   WHERE o.id = p_org RETURNING * INTO v_o;
  RETURN jsonb_build_object('id', v_o.id, 'slug', v_o.slug, 'name_ar', v_o.name_ar, 'name_en', v_o.name_en,
                            'default_locale', v_o.default_locale, 'public_intake_enabled', v_o.public_intake_enabled,
                            'settings', v_o.settings, 'updated_at', v_o.updated_at);
END $$;

CREATE OR REPLACE FUNCTION public.admin_create_branch(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_f jsonb; v_b public.branches;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['code','name_ar','name_en','city','is_active']);
  IF NOT (p_payload ? 'code') THEN PERFORM app.fail('MRS_REQUIRED', 'code'); END IF;
  IF NOT (p_payload ? 'name_ar') THEN PERFORM app.fail('MRS_REQUIRED', 'name_ar'); END IF;
  v_f := app.branch_fields(p_payload);
  IF EXISTS (SELECT 1 FROM public.branches b WHERE b.org_id = p_org AND b.code = v_f ->> 'code') THEN
    PERFORM app.fail('MRS_INVALID', 'code_taken');
  END IF;
  INSERT INTO public.branches (org_id, code, name_ar, name_en, city, is_active)
  VALUES (p_org, v_f ->> 'code', v_f ->> 'name_ar', v_f ->> 'name_en', v_f ->> 'city',
          coalesce((v_f ->> 'is_active')::boolean, true))
  RETURNING * INTO v_b;
  RETURN app.branch_json(v_b);
END $$;

-- code is immutable after create; the last active branch cannot be deactivated
CREATE OR REPLACE FUNCTION public.admin_update_branch(p_branch uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_f jsonb; v_b public.branches;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_b FROM public.branches b WHERE b.id = p_branch FOR UPDATE;
  IF v_b.id IS NULL OR NOT app.has_role(v_b.org_id, ARRAY['admin']) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['code','name_ar','name_en','city','is_active']);
  v_f := app.branch_fields(p_payload);
  IF v_f ? 'code' AND v_f ->> 'code' <> v_b.code THEN PERFORM app.fail('MRS_IMMUTABLE', 'code'); END IF;
  IF v_f ? 'is_active' AND NOT (v_f ->> 'is_active')::boolean AND v_b.is_active THEN
    -- lock the org's branches so two concurrent deactivations cannot both pass
    PERFORM 1 FROM public.branches b WHERE b.org_id = v_b.org_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.org_id = v_b.org_id AND b.is_active AND b.id <> v_b.id) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'last_branch');
    END IF;
  END IF;
  UPDATE public.branches b
     SET name_ar   = CASE WHEN v_f ? 'name_ar' THEN v_f ->> 'name_ar' ELSE b.name_ar END,
         name_en   = CASE WHEN v_f ? 'name_en' THEN v_f ->> 'name_en' ELSE b.name_en END,
         city      = CASE WHEN v_f ? 'city' THEN v_f ->> 'city' ELSE b.city END,
         is_active = CASE WHEN v_f ? 'is_active' THEN (v_f ->> 'is_active')::boolean ELSE b.is_active END
   WHERE b.id = v_b.id RETURNING * INTO v_b;
  RETURN app.branch_json(v_b);
END $$;

-- ---------------------------------------------------------------------
-- 11. invitations RPCs
-- ---------------------------------------------------------------------
-- payload {email, role, branch_id?, client_id?, idempotencyKey}
-- admin: any role. branch_manager: clearance_staff / transport_staff / accountant of
-- its own branch, and client-portal invitations. Never looks at auth.users.
CREATE OR REPLACE FUNCTION public.admin_invite(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key    uuid;
  v_replay jsonb;
  v_admin  boolean;
  v_email  text;
  v_role   text;
  v_branch uuid;
  v_client uuid;
  v_inv    record;
  v_res    jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','branch_manager']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  v_admin := app.has_role(p_org, ARRAY['admin']);
  PERFORM app.only_keys(p_payload, ARRAY['email','role','branch_id','client_id','idempotencyKey']);
  v_key := app.idem_key_from(p_payload);

  v_email := lower(app.ptext(p_payload, 'email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  v_role := app.ptext(p_payload, 'role', 40, true);
  IF NOT (v_role = ANY (app.all_roles())) THEN PERFORM app.fail('MRS_INVALID', 'role'); END IF;
  v_branch := app.puuid(p_payload, 'branch_id');
  v_client := app.puuid(p_payload, 'client_id');

  IF v_role = 'client' THEN
    IF v_client IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client_id'); END IF;
    IF v_branch IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'branch'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client AND c.org_id = p_org AND c.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'client');
    END IF;
  ELSE
    IF v_client IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'client_id'); END IF;
    IF v_role = 'branch_manager' AND v_branch IS NULL THEN PERFORM app.fail('MRS_BRANCH_REQUIRED'); END IF;
    IF v_role = 'admin' AND v_branch IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'branch'); END IF;
    IF v_branch IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = p_org AND b.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'branch');
    END IF;
  END IF;

  -- who may invite what (G2_SPEC "Roles")
  IF NOT v_admin THEN
    -- a branch manager never invites itself (a second membership / a client link
    -- would survive its own deactivation). Reads only the CALLER's own e-mail.
    IF v_email = (SELECT lower(btrim(u.email)) FROM auth.users u WHERE u.id = auth.uid()) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'email');
    END IF;
    IF v_role = 'client' THEN
      -- clients are org-wide: only clients whose transactions / requests all sit in the
      -- caller's branch(es); anything else needs an org admin
      IF NOT app.bm_client_in_scope(auth.uid(), p_org, v_client) THEN PERFORM app.fail('MRS_FORBIDDEN', 'client'); END IF;
    ELSIF NOT (v_role = ANY (app.bm_managed_roles())) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'role');
    ELSIF v_branch IS NULL OR NOT app.has_branch_role(p_org, v_branch, ARRAY['branch_manager']) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'branch');
    END IF;
  END IF;

  v_replay := app.idem_begin('admin_invite', v_key, p_payload, p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT * INTO v_inv FROM app.create_invitation(p_org, v_email, v_role, v_branch, v_client);
  -- the stored replay copy never holds the token
  v_res := jsonb_build_object('invitation_id', v_inv.id, 'email', v_email, 'role', v_role,
                              'branch_id', v_branch, 'client_id', v_client, 'expires_at', v_inv.expires_at,
                              'token', NULL, 'accept_path', NULL, 'token_shown', true);
  PERFORM app.idem_finish('admin_invite', v_key, v_res);
  RETURN v_res || jsonb_build_object('token', v_inv.token, 'accept_path', 'login.html?invite=' || v_inv.token,
                                     'token_shown', false);
END $$;

CREATE OR REPLACE FUNCTION public.admin_list_invitations(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','branch_manager']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', i.id, 'email', i.email, 'role', i.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
             'branch_id', i.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
             'client_id', i.client_id, 'client_name_ar', c.name_ar,
             'status', app.invitation_status(i), 'expires_at', i.expires_at,
             'invited_by', i.invited_by, 'invited_by_email', ui.email, 'created_at', i.created_at,
             'accepted_at', i.accepted_at, 'accepted_by_email', ua.email,
             'revoked_at', i.revoked_at, 'updated_at', i.updated_at)
           ORDER BY i.created_at DESC)
      FROM public.invitations i
      LEFT JOIN public.branches b ON b.id = i.branch_id
      LEFT JOIN public.clients c ON c.id = i.client_id
      LEFT JOIN auth.users ui ON ui.id = i.invited_by
      LEFT JOIN auth.users ua ON ua.id = i.accepted_by
      LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = i.role
     WHERE i.org_id = p_org AND app.can_manage_invitation(i)), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.admin_revoke_invitation(p_invitation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.invitations;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_i FROM public.invitations i WHERE i.id = p_invitation FOR UPDATE;
  IF v_i.id IS NULL OR NOT app.can_manage_invitation(v_i) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_i.accepted_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'accepted'); END IF;
  IF v_i.revoked_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'revoked'); END IF;
  UPDATE public.invitations i SET revoked_at = now(), revoked_by = auth.uid() WHERE i.id = v_i.id RETURNING * INTO v_i;
  RETURN jsonb_build_object('invitation_id', v_i.id, 'status', app.invitation_status(v_i), 'revoked_at', v_i.revoked_at);
END $$;

-- new token + fresh expiry; the old token stops working (only the new hash is kept)
CREATE OR REPLACE FUNCTION public.admin_reissue_invitation(p_invitation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.invitations; v_token text := app.new_token();
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_i FROM public.invitations i WHERE i.id = p_invitation FOR UPDATE;
  IF v_i.id IS NULL OR NOT app.can_manage_invitation(v_i) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_i.accepted_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'accepted'); END IF;
  IF v_i.revoked_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'revoked'); END IF;
  -- the re-issuer takes the invitation over: its authority now backs the new link
  UPDATE public.invitations i
     SET token_hash = app.hash_token(v_token), expires_at = now() + interval '7 days', invited_by = auth.uid()
   WHERE i.id = v_i.id RETURNING * INTO v_i;
  RETURN jsonb_build_object('invitation_id', v_i.id, 'email', v_i.email, 'role', v_i.role,
                            'branch_id', v_i.branch_id, 'client_id', v_i.client_id, 'expires_at', v_i.expires_at,
                            'token', v_token, 'accept_path', 'login.html?invite=' || v_token);
END $$;

-- anon + authenticated. Uniform MRS_NOT_FOUND for unknown / expired / revoked / accepted.
CREATE OR REPLACE FUNCTION public.invitation_preview(p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.invitations; v_res jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  SELECT * INTO v_i FROM public.invitations i WHERE i.token_hash = app.hash_token(p_token);
  IF v_i.id IS NULL OR app.invitation_status(v_i) <> 'pending' OR NOT app.invitation_authorized(v_i) THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;
  SELECT jsonb_build_object(
           'org_name_ar', o.name_ar, 'org_name_en', o.name_en,
           'role', v_i.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
           'branch_name_ar', b.name_ar, 'email_masked', app.mask_email(v_i.email), 'expires_at', v_i.expires_at)
    INTO v_res
    FROM public.organizations o
    LEFT JOIN public.branches b ON b.id = v_i.branch_id
    LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = v_i.role
   WHERE o.id = v_i.org_id AND o.is_active;
  IF v_res IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  RETURN v_res;
END $$;

-- The signed-in account's e-mail must equal the invited one and be confirmed.
-- Creates / reactivates the membership (client invites: 'client' membership + client_users link).
-- Idempotent for the same user: a second call returns the same result and changes nothing.
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_i    public.invitations;
  v_user record;
  v_m    public.memberships;
  v_role text;
  v_cu   uuid;
BEGIN
  IF v_uid IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  SELECT * INTO v_i FROM public.invitations i WHERE i.token_hash = app.hash_token(p_token) FOR UPDATE;
  IF v_i.id IS NULL OR v_i.revoked_at IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_i.org_id AND o.is_active) THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;
  v_role := v_i.role;

  IF v_i.accepted_at IS NOT NULL THEN
    IF v_i.accepted_by IS DISTINCT FROM v_uid THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
    -- replay: fall through to the result below without touching anything
  ELSE
    -- the inviter must still hold the authority to grant this (same error as revoked)
    IF NOT app.invitation_authorized(v_i) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
    IF v_i.expires_at <= now() THEN PERFORM app.fail('MRS_EXPIRED'); END IF;
    SELECT u.email, u.email_confirmed_at INTO v_user FROM auth.users u WHERE u.id = v_uid;
    IF v_user.email IS NULL OR lower(btrim(v_user.email)) <> v_i.email THEN PERFORM app.fail('MRS_EMAIL_MISMATCH'); END IF;
    IF v_user.email_confirmed_at IS NULL THEN PERFORM app.fail('MRS_EMAIL_UNCONFIRMED'); END IF;
    -- self-invitations only count when an org admin issued them
    IF v_i.invited_by = v_uid AND NOT app.uid_has_branch_role(v_uid, v_i.org_id, NULL, ARRAY['admin']) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'self_invite');
    END IF;
    IF v_i.branch_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.branches b WHERE b.id = v_i.branch_id AND b.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'branch');
    END IF;
    IF v_i.client_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.clients c WHERE c.id = v_i.client_id AND c.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'client');
    END IF;

    INSERT INTO public.profiles (id) VALUES (v_uid) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_m FROM public.memberships m
     WHERE m.user_id = v_uid AND m.org_id = v_i.org_id AND m.role = v_role
       AND m.branch_id IS NOT DISTINCT FROM v_i.branch_id
     FOR UPDATE;
    IF v_m.id IS NULL THEN
      INSERT INTO public.memberships (user_id, org_id, branch_id, role, created_by)
      VALUES (v_uid, v_i.org_id, v_i.branch_id, v_role, v_i.invited_by);
    ELSIF NOT v_m.is_active THEN
      UPDATE public.memberships m SET is_active = true WHERE m.id = v_m.id;
    END IF;
    IF v_i.client_id IS NOT NULL THEN
      INSERT INTO public.client_users AS cu (org_id, client_id, user_id, role, created_by)
      VALUES (v_i.org_id, v_i.client_id, v_uid, 'member', v_i.invited_by)
      ON CONFLICT (client_id, user_id) DO UPDATE SET is_active = true WHERE NOT cu.is_active;
    END IF;
    UPDATE public.invitations i SET accepted_at = now(), accepted_by = v_uid WHERE i.id = v_i.id RETURNING * INTO v_i;
  END IF;

  SELECT * INTO v_m FROM public.memberships m
   WHERE m.user_id = v_uid AND m.org_id = v_i.org_id AND m.role = v_role
     AND m.branch_id IS NOT DISTINCT FROM v_i.branch_id;
  SELECT cu.id INTO v_cu FROM public.client_users cu WHERE cu.client_id = v_i.client_id AND cu.user_id = v_uid;
  RETURN jsonb_build_object('invitation_id', v_i.id, 'org_id', v_i.org_id,
                            'org_slug', (SELECT o.slug FROM public.organizations o WHERE o.id = v_i.org_id),
                            'role', v_i.role, 'branch_id', v_i.branch_id, 'client_id', v_i.client_id,
                            'membership_id', v_m.id, 'client_user_id', v_cu, 'accepted_at', v_i.accepted_at);
END $$;

-- ---------------------------------------------------------------------
-- 12. members (0650) — branch_manager manages the lower roles of its branch
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_members(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','branch_manager']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', m.id, 'user_id', m.user_id, 'email', u.email,
             'full_name', p.full_name, 'phone', p.phone,
             'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
             'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
             'is_active', m.is_active, 'created_at', m.created_at, 'updated_at', m.updated_at,
             'is_me', m.user_id = auth.uid(),
             'can_manage', m.user_id <> auth.uid() AND app.can_manage_member(m.org_id, m.branch_id, m.role))
           ORDER BY m.is_active DESC, s.sort DESC, u.email)
      FROM public.memberships m
      LEFT JOIN auth.users u        ON u.id = m.user_id
      LEFT JOIN public.profiles p   ON p.id = m.user_id
      LEFT JOIN public.branches b   ON b.id = m.branch_id
      LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
     WHERE m.org_id = p_org
       AND (m.user_id = auth.uid() OR app.can_manage_member(m.org_id, m.branch_id, m.role))), '[]'::jsonb);
END $$;

-- Deactivation also: switches off the user's client-portal links in the org (role
-- 'client'; reactivation restores only the links from its accepted invitations),
-- revokes the user's pending invitations in the org and the ones it issued that
-- it may no longer grant. The last-admin guard serializes on the organization row.
CREATE OR REPLACE FUNCTION public.admin_set_member_active(p_membership uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_m public.memberships; v_admins int; v_email text; v_revoked int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  -- two admins deactivating each other at once: both lock the org row first, so the
  -- second waits and then counts the first one's change (no org left without an admin)
  SELECT * INTO v_m FROM public.memberships m WHERE m.id = p_membership;
  IF v_m.id IS NOT NULL AND v_m.role = 'admin' THEN
    PERFORM 1 FROM public.organizations o WHERE o.id = v_m.org_id FOR NO KEY UPDATE;
  END IF;
  SELECT * INTO v_m FROM public.memberships m WHERE m.id = p_membership FOR UPDATE;
  IF v_m.id IS NULL OR NOT app.can_manage_member(v_m.org_id, v_m.branch_id, v_m.role) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF p_active IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'status'); END IF;
  IF v_m.is_active = p_active THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT p_active THEN
    IF v_m.user_id = auth.uid() THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
    IF v_m.role = 'admin' THEN
      SELECT count(*) INTO v_admins FROM public.memberships m
       WHERE m.org_id = v_m.org_id AND m.role = 'admin' AND m.is_active AND m.id <> v_m.id;
      IF v_admins = 0 THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
    END IF;
  END IF;
  UPDATE public.memberships m SET is_active = p_active WHERE m.id = v_m.id RETURNING * INTO v_m;

  IF v_m.role = 'client' THEN
    UPDATE public.client_users cu SET is_active = p_active
     WHERE cu.user_id = v_m.user_id AND cu.org_id = v_m.org_id AND cu.is_active <> p_active
       AND (NOT p_active OR cu.client_id IN (
             SELECT i.client_id FROM public.invitations i
              WHERE i.org_id = v_m.org_id AND i.role = 'client' AND i.accepted_by = v_m.user_id));
  END IF;

  IF NOT p_active THEN
    SELECT lower(btrim(u.email)) INTO v_email FROM auth.users u WHERE u.id = v_m.user_id;
    WITH r AS (
      UPDATE public.invitations i SET revoked_at = now(), revoked_by = auth.uid()
       WHERE i.org_id = v_m.org_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
         AND ((v_email IS NOT NULL AND i.email = v_email AND app.can_manage_invitation(i))   -- addressed to the user
              OR (i.invited_by = v_m.user_id AND NOT app.invitation_authorized(i)))           -- no longer backed
      RETURNING 1)
    SELECT count(*) INTO v_revoked FROM r;
  END IF;
  RETURN jsonb_build_object('id', v_m.id, 'is_active', v_m.is_active, 'role', v_m.role,
                            'invitations_revoked', v_revoked);
END $$;

-- ---------------------------------------------------------------------
-- 13. my_context(): existing keys unchanged + is_platform_admin + organizations[]
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  RETURN jsonb_build_object(
    'user_id', v_uid,
    'profile', (SELECT to_jsonb(p) FROM public.profiles p WHERE p.id = v_uid),
    'memberships', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', m.org_id, 'org_slug', o.slug, 'org_name_ar', o.name_ar, 'org_name_en', o.name_en,
               'environment', o.environment,
               'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
               'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en)
             ORDER BY o.slug, s.sort DESC)
        FROM public.memberships m
        JOIN public.organizations o ON o.id = m.org_id AND o.is_active
        LEFT JOIN public.branches b ON b.id = m.branch_id
        LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
       WHERE m.user_id = v_uid AND m.is_active), '[]'::jsonb),
    'clients', coalesce((
      SELECT jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', c.org_id, 'name_ar', c.name_ar, 'link_role', cu.role))
        FROM public.client_users cu JOIN public.clients c ON c.id = cu.client_id
       -- same rule as data access: active client + active org + client membership not deactivated
       WHERE cu.user_id = v_uid AND cu.is_active AND cu.client_id IN (SELECT app.my_client_ids())), '[]'::jsonb),
    'is_platform_admin', app.is_platform_admin(),
    'organizations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en,
               'environment', o.environment, 'default_locale', o.default_locale, 'roles', to_jsonb(x.roles))
             ORDER BY o.slug)
        FROM (SELECT m.org_id, array_agg(DISTINCT m.role ORDER BY m.role) roles
                FROM public.memberships m WHERE m.user_id = v_uid AND m.is_active GROUP BY m.org_id) x
        JOIN public.organizations o ON o.id = x.org_id AND o.is_active), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------
-- 13b. public_track (body from 0400): a suspended organization's requests /
--      transactions are not trackable (same MRS_NOT_FOUND, no oracle)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_track(p_ref text, p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ref  text := upper(btrim(coalesce(p_ref, '')));
  v_tok  text := lower(btrim(coalesce(p_token, '')));
  v_hash text;
  v_req  public.service_requests;
  v_tx   public.transactions;
  v_res  jsonb;
  v_tl   jsonb;
BEGIN
  IF v_ref !~ '^[A-Z]{2,5}-[0-9]{4}-[0-9]{6,}$' OR v_tok !~ '^[0-9a-f]{64}$' THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;
  v_hash := app.hash_token(v_tok);

  SELECT * INTO v_req FROM public.service_requests r WHERE r.ref = v_ref AND r.tracking_token_hash = v_hash LIMIT 1;
  IF v_req.id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.request_id = v_req.id;
  ELSE
    SELECT * INTO v_tx FROM public.transactions t WHERE t.ref = v_ref AND t.tracking_token_hash = v_hash LIMIT 1;
    IF v_tx.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = coalesce(v_req.org_id, v_tx.org_id) AND o.is_active) THEN
    PERFORM app.fail('MRS_NOT_FOUND');
  END IF;

  v_res := jsonb_build_object('ref', v_ref, 'environment', 'staging');

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
    SELECT coalesce(jsonb_agg(jsonb_build_object('status', e.to_status, 'label_ar', s.label_ar, 'label_en', s.label_en,
                                                 'at', e.created_at) ORDER BY e.created_at, e.id), '[]'::jsonb)
      INTO v_tl
      FROM public.transaction_events e
      JOIN public.status_labels s ON s.domain = 'operational_status' AND s.code = e.to_status
     WHERE e.transaction_id = v_tx.id AND e.visible_to_client AND e.event_type IN ('created','operational_status');
    v_res := v_res || jsonb_build_object('transaction', jsonb_build_object(
      'ref', v_tx.ref,
      'operation', v_tx.operation, 'mode', v_tx.mode,
      'operational_status', v_tx.operational_status,
      'status_label_ar', (SELECT s.label_ar FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'status_label_en', (SELECT s.label_en FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'stage_index', (SELECT s.sort FROM public.status_labels s WHERE s.domain = 'operational_status' AND s.code = v_tx.operational_status),
      'stage_total', 10,
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
-- 14. privileges
-- ---------------------------------------------------------------------
-- app.* helpers: nothing callable from the API except what policies / CHECKs need
REVOKE EXECUTE ON FUNCTION
  app.is_platform_admin(), app.can_manage_member(uuid, uuid, text),
  app.can_manage_invitation(public.invitations), app.invitation_status(public.invitations), app.mask_email(text),
  app.only_keys(jsonb, text[]), app.puuid(jsonb, text), app.branch_fields(jsonb), app.branch_json(public.branches),
  app.create_invitation(uuid, text, text, uuid, uuid),
  app.uid_has_branch_role(uuid, uuid, uuid, text[]), app.bm_client_in_scope(uuid, uuid, uuid),
  app.invitation_authorized(public.invitations)
FROM PUBLIC, anon, authenticated;

-- pure role list used by the invitations_select policy (runs as the caller)
REVOKE EXECUTE ON FUNCTION app.bm_managed_roles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.bm_managed_roles() TO authenticated;

-- admin_add_member stays for the SQL Editor only (account-existence oracle; the UI uses invitations)
REVOKE EXECUTE ON FUNCTION public.admin_add_member(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.platform_list_orgs(), public.platform_create_org(jsonb), public.platform_set_org_active(uuid, boolean),
  public.admin_update_org(uuid, jsonb), public.admin_create_branch(uuid, jsonb), public.admin_update_branch(uuid, jsonb),
  public.admin_invite(uuid, jsonb), public.admin_list_invitations(uuid), public.admin_revoke_invitation(uuid),
  public.admin_reissue_invitation(uuid), public.invitation_preview(text), public.accept_invitation(text),
  public.admin_list_members(uuid), public.admin_set_member_active(uuid, boolean), public.my_context(),
  public.set_transaction_status(uuid, text, text), public.platform_reissue_admin_invitation(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.invitation_preview(text) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.platform_list_orgs(), public.platform_create_org(jsonb), public.platform_set_org_active(uuid, boolean),
  public.admin_update_org(uuid, jsonb), public.admin_create_branch(uuid, jsonb), public.admin_update_branch(uuid, jsonb),
  public.admin_invite(uuid, jsonb), public.admin_list_invitations(uuid), public.admin_revoke_invitation(uuid),
  public.admin_reissue_invitation(uuid), public.accept_invitation(text),
  public.admin_list_members(uuid), public.admin_set_member_active(uuid, boolean), public.my_context(),
  public.set_transaction_status(uuid, text, text), public.platform_reissue_admin_invitation(uuid)
TO authenticated;

-- Re-run safety: 20261102000300 replaces set_transaction_status(uuid, text, text) with a
-- 4-argument version (p_idem_key uuid DEFAULT NULL; same body incl. branch_manager). If this
-- file is re-run on its own after 0300, drop the 3-argument overload it just recreated, or
-- every 3-argument call becomes ambiguous ("function ... is not unique").
-- (G3 20261103000200 adds a 5th parameter, p_docs_override: same rule for that version.)
DO $reruns$
BEGIN
  IF to_regprocedure('public.set_transaction_status(uuid, text, text, uuid)') IS NOT NULL
     OR to_regprocedure('public.set_transaction_status(uuid, text, text, uuid, boolean)') IS NOT NULL THEN
    DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text);
  END IF;
END $reruns$;
