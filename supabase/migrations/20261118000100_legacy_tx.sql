-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261118000100 — legacy port, step 2: transaction form + lifecycle + guards
-- (نموذج المعاملة ودورة الحياة والحمايات) — docs/online/LEGACY_TX_AR.md, plan docs/online/LEGACY_PORT_PLAN_AR.md.
-- Builds on legacy_core (20261117000100). Database side of step 2; the screens use the RPCs below.
--   P. preflight (legacy_core applied, cancel_transaction present) + schema_versions row
--   0. dictionaries status_labels: movement_status (registered / incomplete / delivered / cancelled, staff only),
--                   transaction_state (cancelled = «ملغاة», client visible: portal + public tracking)
--   1. duplicate guard (legacy assertNoDuplicateTransaction_): a live (not cancelled) transaction of the same org that
--                   already holds the same container under the same B/L (the container's own B/L, else the transaction's
--                   primary B/L; legacy normalizeSearch_ key = app.legacy_search_key) — or, for Ro-Ro, the same chassis with
--                   the same B/L — is refused: MRS_DUPLICATE_TX container | chassis. Enforced by triggers on containers
--                   (insert / renumber / B/L change) and transactions (B/L, chassis, cargo type), serialised per (org, B/L)
--                   with an advisory lock. app.tx_dup_conflicts(...) is the one rule; public.check_tx_duplicates(org,
--                   payload) is the form's pre-check (+ the non-blocking «container still open in another transaction»
--                   warning, DEC-02 keeps a number reusable across transactions).
--   2. lifecycle   app.advance_tx_status(tx, target, cause): automatic, forward only, never a gate bypass (the
--                   container-return gate of operationally_complete, the G3.10 document gate, under_billing / closed stay
--                   manual). Triggers (user actions only: app.auto_lifecycle_on): declaration added → customs_declaration;
--                   declaration released → appointment (container) / operationally_complete (Ro-Ro: no appointment, no
--                   empty return); appointment created → appointment; trip created → transport; container return recorded
--                   (from transport on) → empty_return; invoice issued (financial_status invoiced / settled) while
--                   under_billing → billed. Each move = a client-visible operational_status event
--                   (payload auto = true, cause). public.tx_lifecycle(tx) feeds the stepper.
--   3. appointments duplicate rule (legacy findDuplicateMovementRow_): a live appointment (not cancelled / rescheduled /
--                   missed) of the same transaction + container + appointment minute,
--                   and the same appointment number when the new one has one → MRS_DUPLICATE_APPOINTMENT (trigger, every
--                   path); unique index port_appointments_dup_uidx as the race backstop (created only when the data is
--                   clean — re-run after fixing duplicates). A reschedule moves the linked trip to the new appointment.
--   4. movements   transport_trips.appointment_id (one live trip per appointment), drivers.last_truck_id;
--                   public.save_movement(payload, idem) = legacy saveMovement: appointment + trip + container return plan in
--                   one call, driver / truck find-or-create (phone / plate), legacy statuses, idempotent duplicate replay;
--                   public.list_movements(tx); public.driver_directory(org, q).
--   5. ports       public.port_operators(org, port): terminal operators for a port (mapped, or not mapped to any port).
--   6. cancelled   public.public_track re-created (20261113000100): + cancelled / cancelled_at, «ملغاة» label.
--   7. column grant transport_trips (+ appointment_id; finance columns stay hidden)
--   8. privileges
-- Errors: + MRS_DUPLICATE_TX (container | chassis), MRS_DUPLICATE_APPOINTMENT; otherwise existing codes.
-- Re-runnable (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS + CREATE / ON CONFLICT). Re-pasting
-- 20261113000100 (public_antispam) or 20261112000100 (deploy_env) after this file drops the cancelled flag from public_track:
-- re-paste this file right after.
-- Down-path (staging only): DROP the triggers trg_legacy_tx_* / trg_legacy_dup_*, the functions of §1–§5, the index
-- port_appointments_dup_uidx / transport_trips_appointment_uidx / drivers_org_phone_idx, ALTER TABLE … DROP COLUMN
-- transport_trips.appointment_id / drivers.last_truck_id; re-paste 20261113000100 (public_track).
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261117000100') THEN
    RAISE EXCEPTION 'LEGACY TX preflight: apply legacy_core first (schema_versions lacks 20261117000100 legacy_core)';
  END IF;
  IF to_regprocedure('public.cancel_transaction(uuid,text)') IS NULL OR to_regclass('public.party_ports') IS NULL THEN
    RAISE EXCEPTION 'LEGACY TX preflight: public.cancel_transaction / public.party_ports missing (apply 20261117000100 legacy_core)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261118000100', 'legacy_tx')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  -- the legacy movement status (resolveMovementStatus_), derived from the appointment + trip
  ('movement_status','registered',1,'موعد مسجل','Appointment registered',false),
  ('movement_status','incomplete',2,'موعد مسجل — بيانات النقل ناقصة','Appointment registered — transport data missing',false),
  ('movement_status','delivered',3,'تم النقل','Delivered',false),
  ('movement_status','cancelled',4,'ملغى','Cancelled',false),
  -- what the staff screens, the client portal and public tracking show for a cancelled transaction (operational_status
  -- stays 'closed' with cancelled_at set — 20261117000100)
  ('transaction_state','cancelled',1,'ملغاة','Cancelled',true)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. duplicate transaction guard (B/L + container, B/L + chassis)
-- ---------------------------------------------------------------------
-- the B/L a container travels under: its own B/L (containers.bl_id, G3 many-to-many) or else the transaction's primary
-- B/L (transactions.bl_number) — compared through the legacy normalizeSearch_ key
CREATE OR REPLACE FUNCTION app.container_bl_key(p_bl_id uuid, p_tx_bl text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.legacy_search_key(coalesce((SELECT b.bl_number FROM public.bills_of_lading b WHERE b.id = p_bl_id), p_tx_bl))
$$;

-- every live (not cancelled) transaction of p_org other than p_tx that already holds one of p_containers under the same B/L
-- key as p_bl (cargo container), or — cargo roro — the same chassis with the same transaction B/L.
-- kind = 'container' | 'chassis', unit = the container number / the chassis. No B/L → no conflict (DEC-02: a container
-- number repeats across transactions over time; only the same B/L + the same unit is the same shipment twice).
CREATE OR REPLACE FUNCTION app.tx_dup_conflicts(p_org uuid, p_tx uuid, p_bl text, p_cargo text, p_chassis text, p_containers text[])
RETURNS TABLE (transaction_id uuid, kind text, unit text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH k AS (SELECT app.legacy_search_key(p_bl) AS bl)
  SELECT t.id, 'chassis'::text, t.chassis_no
    FROM public.transactions t, k
   WHERE k.bl IS NOT NULL AND coalesce(p_cargo, 'container') = 'roro' AND app.norm_chassis(p_chassis) IS NOT NULL
     AND t.org_id = p_org AND t.chassis_no = app.norm_chassis(p_chassis) AND t.cargo_unit_type = 'roro'
     AND t.id IS DISTINCT FROM p_tx AND t.cancelled_at IS NULL AND app.legacy_search_key(t.bl_number) = k.bl
  UNION ALL
  SELECT t.id, 'container'::text, c.container_no
    FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id, k
   WHERE k.bl IS NOT NULL AND coalesce(p_cargo, 'container') <> 'roro' AND p_containers IS NOT NULL
     AND c.org_id = p_org AND c.container_no = ANY (p_containers)
     AND t.id IS DISTINCT FROM p_tx AND t.cancelled_at IS NULL AND app.container_bl_key(c.bl_id, t.bl_number) = k.bl
  ORDER BY 2, 3, 1
$$;

-- one writer at a time per (org, B/L key): two sessions saving the same B/L + unit cannot both pass
CREATE OR REPLACE FUNCTION app.tx_dup_lock(p_org uuid, p_bl text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = '' AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('mrs_tx_dup:' || p_org::text || ':' || coalesce(app.legacy_search_key(p_bl), ''), 0))
$$;

-- transactions: the primary B/L / chassis / cargo type written (INSERT, or one of them changed) → no live twin. On a B/L
-- change the containers that follow the transaction's B/L (no own bl_id) are checked under the new B/L.
CREATE OR REPLACE FUNCTION app.tg_transactions_legacy_dup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text;
BEGIN
  IF NEW.cancelled_at IS NOT NULL OR app.legacy_search_key(NEW.bl_number) IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND app.legacy_search_key(NEW.bl_number) IS NOT DISTINCT FROM app.legacy_search_key(OLD.bl_number)
     AND NEW.chassis_no IS NOT DISTINCT FROM OLD.chassis_no AND NEW.cargo_unit_type IS NOT DISTINCT FROM OLD.cargo_unit_type THEN
    RETURN NEW;
  END IF;
  PERFORM app.tx_dup_lock(NEW.org_id, NEW.bl_number);
  SELECT x.kind INTO v_kind
    FROM app.tx_dup_conflicts(NEW.org_id, NEW.id, NEW.bl_number, NEW.cargo_unit_type, NEW.chassis_no,
                              CASE WHEN TG_OP = 'UPDATE'
                                   THEN ARRAY(SELECT c.container_no FROM public.containers c
                                               WHERE c.transaction_id = NEW.id AND c.bl_id IS NULL) END) x
   LIMIT 1;
  IF v_kind IS NOT NULL THEN PERFORM app.fail('MRS_DUPLICATE_TX', v_kind); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_dup ON public.transactions;
CREATE TRIGGER trg_legacy_tx_dup BEFORE INSERT OR UPDATE OF bl_number, chassis_no, cargo_unit_type ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_legacy_dup();

-- containers: a container added to a live transaction, renumbered or moved to another B/L → no live twin under its B/L.
-- Fires after trg_before (which normalises container_no).
CREATE OR REPLACE FUNCTION app.tg_containers_legacy_dup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_bl text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.container_no IS NOT DISTINCT FROM OLD.container_no AND NEW.bl_id IS NOT DISTINCT FROM OLD.bl_id THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = NEW.transaction_id;
  IF v_tx.id IS NULL OR v_tx.cancelled_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT coalesce((SELECT b.bl_number FROM public.bills_of_lading b WHERE b.id = NEW.bl_id), v_tx.bl_number) INTO v_bl;
  IF app.legacy_search_key(v_bl) IS NULL THEN RETURN NEW; END IF;
  PERFORM app.tx_dup_lock(v_tx.org_id, v_bl);
  IF EXISTS (SELECT 1 FROM app.tx_dup_conflicts(v_tx.org_id, v_tx.id, v_bl, 'container', NULL, ARRAY[NEW.container_no])) THEN
    PERFORM app.fail('MRS_DUPLICATE_TX', 'container');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_dup ON public.containers;
CREATE TRIGGER trg_legacy_tx_dup BEFORE INSERT OR UPDATE OF container_no, bl_id ON public.containers
  FOR EACH ROW EXECUTE FUNCTION app.tg_containers_legacy_dup();

-- bills_of_lading: a renumbered B/L moves every container that points at it (containers.bl_id) to the new number →
-- no live twin under the new number (review fix: save_bl {id, bl_number} bypassed the container trigger). The
-- containers that follow a transaction's primary B/L without their own bl_id, and the Ro-Ro chassis, are checked by
-- trg_legacy_tx_dup on transactions when the mirror (trg_mirror) rewrites transactions.bl_number.
CREATE OR REPLACE FUNCTION app.tg_bills_of_lading_legacy_dup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  IF app.legacy_search_key(NEW.bl_number) IS NULL
     OR app.legacy_search_key(NEW.bl_number) IS NOT DISTINCT FROM app.legacy_search_key(OLD.bl_number) THEN
    RETURN NEW;
  END IF;
  PERFORM app.tx_dup_lock(NEW.org_id, NEW.bl_number);
  FOR r IN SELECT c.container_no, t.id AS tx_id, t.org_id
             FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
            WHERE c.bl_id = NEW.id AND t.cancelled_at IS NULL LOOP
    IF EXISTS (SELECT 1 FROM app.tx_dup_conflicts(r.org_id, r.tx_id, NEW.bl_number, 'container', NULL, ARRAY[r.container_no])) THEN
      PERFORM app.fail('MRS_DUPLICATE_TX', 'container');
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_dup ON public.bills_of_lading;
CREATE TRIGGER trg_legacy_tx_dup BEFORE UPDATE OF bl_number ON public.bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION app.tg_bills_of_lading_legacy_dup();

-- check_tx_duplicates(p_org, {transaction_id?, bl_number, cargo_unit_type?, chassis_no?, containers?: [text]})
-- → {duplicates: [{kind, unit, transaction_id, ref, branch_id, other_branch}], container_elsewhere: [{container_no,
--    transaction_id, ref, operational_status}]} — the form's pre-check before saving (the triggers enforce it anyway).
-- duplicates block the save; container_elsewhere is the non-blocking warning (the same container on another live, not
-- closed transaction whose empty is not returned / waived — any B/L). A twin in a branch the caller cannot read is listed
-- with transaction_id / ref NULL and other_branch true (no data of that branch leaks). Staff of p_org.
CREATE OR REPLACE FUNCTION public.check_tx_duplicates(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx uuid; v_bl text; v_cargo text; v_chassis text; v_ctr text[] := '{}'; v_x text; v_raw jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','bl_number','cargo_unit_type','chassis_no','containers']);
  v_tx := app.puuid(p_payload, 'transaction_id');
  IF v_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = v_tx AND t.org_id = p_org
                                         AND app.has_tx_role(t.id, app.staff_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;
  v_bl := app.ptext(p_payload, 'bl_number', 60);
  v_cargo := coalesce(app.ptext(p_payload, 'cargo_unit_type', 20), 'container');
  IF v_cargo NOT IN ('container','roro') THEN PERFORM app.fail('MRS_INVALID', 'cargo_unit_type'); END IF;
  v_chassis := app.ptext(p_payload, 'chassis_no', 60);
  v_raw := p_payload -> 'containers';
  IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) <> 'null' THEN
    IF jsonb_typeof(v_raw) <> 'array' OR jsonb_array_length(v_raw) > 200 THEN PERFORM app.fail('MRS_INVALID', 'containers'); END IF;
    FOR v_x IN SELECT jsonb_array_elements_text(v_raw) LOOP
      v_x := upper(regexp_replace(app.to_western(coalesce(v_x, '')), '[[:space:]-]', '', 'g'));
      IF v_x <> '' AND NOT (v_x = ANY (v_ctr)) THEN v_ctr := v_ctr || v_x; END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'duplicates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', d.kind, 'unit', d.unit,
               'transaction_id', CASE WHEN app.has_tx_role(t.id, app.staff_roles()) THEN t.id END,
               'ref', CASE WHEN app.has_tx_role(t.id, app.staff_roles()) THEN t.ref END,
               'branch_id', CASE WHEN app.has_tx_role(t.id, app.staff_roles()) THEN t.branch_id END,
               'other_branch', NOT app.has_tx_role(t.id, app.staff_roles())) ORDER BY d.kind, d.unit, t.ref)
        FROM app.tx_dup_conflicts(p_org, v_tx, v_bl, v_cargo, v_chassis, v_ctr) d
        JOIN public.transactions t ON t.id = d.transaction_id), '[]'::jsonb),
    'container_elsewhere', CASE WHEN v_cargo = 'roro' THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('container_no', c.container_no, 'transaction_id', t.id, 'ref', t.ref,
               'operational_status', t.operational_status) ORDER BY c.container_no, t.ref)
        FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
       WHERE t.org_id = p_org AND t.id IS DISTINCT FROM v_tx AND t.cancelled_at IS NULL AND t.operational_status <> 'closed'
         AND c.container_no = ANY (v_ctr) AND c.return_status NOT IN ('returned_verified','waived')
         AND app.has_tx_role(t.id, app.staff_roles())), '[]'::jsonb) END);
END $$;

-- ---------------------------------------------------------------------
-- 2. lifecycle: automatic forward moves (legacy resolveTransactionStatus_ / setTransactionLifecycleStatus_)
-- ---------------------------------------------------------------------
-- Moves p_tx forward to p_target (or as far towards it as the gates allow) and returns the resulting status.
-- Never backwards, never on a cancelled / closed transaction, never into under_billing / closed (manual: owner decision —
-- billing stays blocked without the empty-return proof, set_transaction_status keeps that gate), never past
-- customs_declaration while the transaction has no live (not cancelled / replaced) customs declaration. Gates kept:
--   · operationally_complete (and beyond) needs every container returned_verified / waived and no declared-but-unregistered
--     container (= set_transaction_status) — otherwise it stops at empty_return;
--   · G3.10 mandatory documents (missing / unreviewed) of a stage stop the move before that stage (no override here);
--   · billed only from under_billing.
-- A move writes operational_status + status_changed_at and one client-visible operational_status event
-- (payload {direction: forward, auto: true, cause}). Internal: called by the triggers below and save_movement.
CREATE OR REPLACE FUNCTION app.advance_tx_status(p_tx uuid, p_target text, p_cause text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions; v_from int; v_to int; v_cap int; v_open int; v_code text;
BEGIN
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v_tx.id IS NULL THEN RETURN NULL; END IF;
  IF v_tx.cancelled_at IS NOT NULL OR v_tx.operational_status = 'closed' THEN RETURN v_tx.operational_status; END IF;
  v_from := app.code_sort('operational_status', v_tx.operational_status);
  v_to := app.code_sort('operational_status', p_target);
  IF v_to IS NULL OR p_target IN ('new','in_progress','under_billing','closed') THEN RETURN v_tx.operational_status; END IF;
  IF p_target = 'billed' AND v_tx.operational_status <> 'under_billing' THEN RETURN v_tx.operational_status; END IF;
  IF v_to <= v_from THEN RETURN v_tx.operational_status; END IF;
  -- (review fix) no automatic move from before customs_declaration to past it without a live customs declaration: an
  -- appointment, a trip or a movement on a new / in-progress transaction that has no declaration leaves its stage alone (set_transaction_status keeps its
  -- role matrix and stage-skip rule for the manual path; the automatic path never jumps over customs)
  IF v_from < app.code_sort('operational_status', 'customs_declaration')
     AND v_to > app.code_sort('operational_status', 'customs_declaration')
     AND NOT EXISTS (SELECT 1 FROM public.customs_declarations d
                      WHERE d.transaction_id = v_tx.id AND d.status NOT IN ('cancelled','replaced')) THEN
    RETURN v_tx.operational_status;
  END IF;
  -- the container-return gate (identical to set_transaction_status)
  IF v_to >= app.code_sort('operational_status', 'operationally_complete') AND p_target <> 'billed' THEN
    SELECT count(*) INTO v_open FROM public.containers c
     WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived');
    v_open := greatest(v_open, coalesce(v_tx.container_count, 0)
                               - (SELECT count(*) FROM public.containers c WHERE c.transaction_id = v_tx.id));
    IF v_open > 0 THEN v_to := least(v_to, app.code_sort('operational_status', 'empty_return')); END IF;
  END IF;
  -- the document gate: stop before the first stage ahead whose mandatory documents are missing / unreviewed
  SELECT min(x.stage_sort) - 1 INTO v_cap
    FROM app.tx_requirements(v_tx.id) x
   WHERE NOT x.is_optional AND x.status IN ('missing','unreviewed') AND x.stage_sort > v_from AND x.stage_sort <= v_to;
  IF v_cap IS NOT NULL THEN v_to := least(v_to, v_cap); END IF;
  IF v_to <= v_from THEN RETURN v_tx.operational_status; END IF;
  SELECT l.code INTO v_code FROM public.status_labels l WHERE l.domain = 'operational_status' AND l.sort = v_to;
  IF v_code IS NULL OR v_code IN ('under_billing','closed') THEN RETURN v_tx.operational_status; END IF;
  UPDATE public.transactions t SET operational_status = v_code, status_changed_at = now() WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'operational_status', v_tx.operational_status, v_code, true, auth.uid(),
          jsonb_build_object('direction', 'forward', 'auto', true, 'cause', p_cause));
  RETURN v_code;
END $$;

-- the automatic moves follow user actions only: a request with JWT claims (staff through PostgREST / RPCs, the server
-- workers as service_role). Owner SQL (SQL Editor, seed, migrations, the step-9 import) sets the stages it means to set.
CREATE OR REPLACE FUNCTION app.auto_lifecycle_on() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RETURN (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') IS NOT NULL;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

-- declaration added → customs_declaration (legacy: a declaration number makes the transaction «نشطة»);
-- declaration released (فسح كلي) → appointment for containers (customs done, the appointment is next) /
-- operationally_complete for Ro-Ro (legacy: Ro-Ro has no TAS appointment and no empty return)
CREATE OR REPLACE FUNCTION app.tg_declarations_legacy_tx() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_cargo text;
BEGIN
  IF NEW.status IN ('cancelled','replaced') OR NOT app.auto_lifecycle_on() THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM app.advance_tx_status(NEW.transaction_id, 'customs_declaration', 'declaration');
  END IF;
  IF NEW.status = 'released' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'released') THEN
    SELECT t.cargo_unit_type INTO v_cargo FROM public.transactions t WHERE t.id = NEW.transaction_id;
    PERFORM app.advance_tx_status(NEW.transaction_id,
      CASE WHEN v_cargo = 'roro' THEN 'operationally_complete' ELSE 'appointment' END, 'declaration_released');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_status ON public.customs_declarations;
CREATE TRIGGER trg_legacy_tx_status AFTER INSERT OR UPDATE OF status ON public.customs_declarations
  FOR EACH ROW EXECUTE FUNCTION app.tg_declarations_legacy_tx();

-- appointment created → appointment; a reschedule (new row) takes over the trip of the appointment it replaces
CREATE OR REPLACE FUNCTION app.tg_appointments_legacy_tx() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.rescheduled_from_id IS NOT NULL THEN
    UPDATE public.transport_trips r SET appointment_id = NEW.id
     WHERE r.appointment_id = NEW.rescheduled_from_id AND r.status <> 'cancelled';
  END IF;
  IF NEW.status IN ('requested','confirmed') AND app.auto_lifecycle_on() THEN
    PERFORM app.advance_tx_status(NEW.transaction_id, 'appointment', 'appointment');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_status ON public.port_appointments;
CREATE TRIGGER trg_legacy_tx_status AFTER INSERT ON public.port_appointments
  FOR EACH ROW EXECUTE FUNCTION app.tg_appointments_legacy_tx();

-- trip created → transport (legacy recalculateTransactionReadyForInvoicing_: a saved movement = «مرحلة النقل»)
CREATE OR REPLACE FUNCTION app.tg_trips_legacy_tx() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'cancelled' AND app.auto_lifecycle_on() THEN
    PERFORM app.advance_tx_status(NEW.transaction_id, 'transport', 'trip');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_status ON public.transport_trips;
CREATE TRIGGER trg_legacy_tx_status AFTER INSERT ON public.transport_trips
  FOR EACH ROW EXECUTE FUNCTION app.tg_trips_legacy_tx();

-- container return recorded (evidence submitted / verified / waived), once the transaction is in transport (or later) →
-- empty_return. operationally_complete stays a manual step (set_transaction_status and its return gate): the legacy has no
-- «all returned» trigger — its «منتهية تشغيليًا» is the customs release, mapped above.
CREATE OR REPLACE FUNCTION app.tg_containers_legacy_tx() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_st text;
BEGIN
  IF NOT app.auto_lifecycle_on() OR NEW.return_status IS NOT DISTINCT FROM OLD.return_status
     OR NEW.return_status NOT IN ('evidence_submitted','returned_verified','waived') THEN
    RETURN NULL;
  END IF;
  SELECT t.operational_status INTO v_st FROM public.transactions t WHERE t.id = NEW.transaction_id;
  IF app.code_sort('operational_status', v_st) < app.code_sort('operational_status', 'transport') THEN RETURN NULL; END IF;
  PERFORM app.advance_tx_status(NEW.transaction_id, 'empty_return', 'container_return');
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_status ON public.containers;
CREATE TRIGGER trg_legacy_tx_status AFTER UPDATE OF return_status ON public.containers
  FOR EACH ROW EXECUTE FUNCTION app.tg_containers_legacy_tx();

-- invoice issued in Daftra (G5 financial_status invoiced / settled) while under_billing → billed
-- (legacy promoteTransactionToInvoicedFromDaftraR12110HF1_)
CREATE OR REPLACE FUNCTION app.tg_transactions_legacy_billed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.financial_status IN ('invoiced','settled') AND NEW.financial_status IS DISTINCT FROM OLD.financial_status
     AND NEW.operational_status = 'under_billing' AND app.auto_lifecycle_on() THEN
    PERFORM app.advance_tx_status(NEW.id, 'billed', 'invoiced');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_tx_billed ON public.transactions;
CREATE TRIGGER trg_legacy_tx_billed AFTER UPDATE OF financial_status ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_legacy_billed();

-- tx_lifecycle(p_tx) — the stepper: the 10 stages with done / current / todo / skipped (Ro-Ro: appointment, empty_return) and when each was first reached (auto or by
-- hand), the cancelled state, the next stage and what blocks it (containers not returned, mandatory documents), the
-- pending empty returns (legacy getTransactionEmptyReturnReadiness_: a follow-up list, never a billing waiver).
-- Staff of the transaction's branch.
CREATE OR REPLACE FUNCTION public.tx_lifecycle(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_cur int; v_next text; v_open int; v_docs jsonb; v_pending jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  v_cur := app.code_sort('operational_status', v_tx.operational_status);
  IF v_tx.cancelled_at IS NULL THEN
    -- Ro-Ro: no TAS appointment and no empty return (legacy isRoRoTransaction_), so the stepper never points at them
    SELECT l.code INTO v_next FROM public.status_labels l
     WHERE l.domain = 'operational_status' AND l.sort > v_cur
       AND NOT (v_tx.cargo_unit_type = 'roro' AND l.code IN ('appointment','empty_return'))
     ORDER BY l.sort LIMIT 1;
  END IF;
  SELECT count(*) INTO v_open FROM public.containers c
   WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived');
  v_open := greatest(v_open, coalesce(v_tx.container_count, 0) - (SELECT count(*) FROM public.containers c WHERE c.transaction_id = v_tx.id));
  SELECT coalesce(jsonb_agg(x.document_kind ORDER BY x.document_kind), '[]'::jsonb) INTO v_docs
    FROM app.tx_requirements(v_tx.id) x
   WHERE x.required_for_stage = v_next AND NOT x.is_optional AND x.status IN ('missing','unreviewed');
  SELECT coalesce(jsonb_agg(c.container_no ORDER BY c.container_no), '[]'::jsonb) INTO v_pending
    FROM public.containers c WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived');
  RETURN jsonb_build_object(
    'transaction_id', v_tx.id, 'ref', v_tx.ref, 'operational_status', v_tx.operational_status,
    'status_changed_at', v_tx.status_changed_at, 'cargo_unit_type', v_tx.cargo_unit_type,
    'transaction_type', v_tx.transaction_type, 'transport_mode', v_tx.transport_mode,
    'cancelled', v_tx.cancelled_at IS NOT NULL, 'cancelled_at', v_tx.cancelled_at,
    'stages', (SELECT jsonb_agg(jsonb_build_object(
        'code', l.code, 'sort', l.sort, 'label_ar', l.label_ar, 'label_en', l.label_en,
        'state', CASE WHEN l.sort = v_cur THEN 'current'
                      WHEN v_tx.cargo_unit_type = 'roro' AND l.code IN ('appointment','empty_return') AND e.created_at IS NULL
                        THEN 'skipped'
                      WHEN l.sort < v_cur THEN 'done' ELSE 'todo' END,
        'reached_at', e.created_at, 'auto', coalesce((e.payload ->> 'auto')::boolean, false), 'cause', e.payload ->> 'cause')
        ORDER BY l.sort)
      FROM public.status_labels l
      LEFT JOIN LATERAL (SELECT x.created_at, x.payload FROM public.transaction_events x
                          WHERE x.transaction_id = v_tx.id AND x.event_type IN ('created','operational_status') AND x.to_status = l.code
                          ORDER BY x.created_at, x.id LIMIT 1) e ON true
     WHERE l.domain = 'operational_status'),
    'next', CASE WHEN v_next IS NULL THEN NULL ELSE jsonb_build_object(
        -- manual = no automatic move reaches it: in_progress, under_billing, closed, and operationally_complete on a
        -- container transaction (only a Ro-Ro release moves there automatically)
        'code', v_next, 'manual', v_next IN ('in_progress','under_billing','closed')
                                  OR (v_next = 'operationally_complete' AND coalesce(v_tx.cargo_unit_type, 'container') <> 'roro'),
        'containers_not_returned', CASE WHEN app.code_sort('operational_status', v_next)
                                            >= app.code_sort('operational_status', 'operationally_complete') THEN v_open ELSE 0 END,
        'docs_missing', v_docs) END,
    'pending_containers', v_pending,
    'follow_up_required', jsonb_array_length(v_pending) > 0 AND v_cur >= app.code_sort('operational_status', 'transport'));
END $$;

-- ---------------------------------------------------------------------
-- 3. duplicate appointments (legacy findDuplicateMovementRow_ / assertNoDuplicateMovement_)
-- ---------------------------------------------------------------------
-- the appointment minute in UTC (immutable: usable in the unique index)
CREATE OR REPLACE FUNCTION app.appt_minute(p timestamptz) RETURNS timestamp
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT date_trunc('minute', p AT TIME ZONE 'UTC')
$$;

-- a live appointment (not cancelled / rescheduled / missed: a slot that no longer holds) of the same transaction + container at the same minute that matches:
-- when p_no is given, only one with the same number; without a number, any (legacy: a TAS number narrows the match).
-- Numbers compare by the legacy normalizeSearch_ key (app.legacy_search_key: 'TAS-12345678' = 'tas 12345678' =
-- 'TAS12345678'), so create_appointment (norm_code) and save_movement (norm_tas) see the same number.
CREATE OR REPLACE FUNCTION app.appt_duplicate(p_tx uuid, p_container uuid, p_at timestamptz, p_no text, p_exclude uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id FROM public.port_appointments a
   WHERE a.transaction_id = p_tx AND a.container_id IS NOT DISTINCT FROM p_container
     AND app.appt_minute(a.appointment_at) = app.appt_minute(p_at)
     AND a.status NOT IN ('cancelled','rescheduled','missed') AND a.id IS DISTINCT FROM p_exclude
     AND (p_no IS NULL OR app.legacy_search_key(a.appointment_no) = app.legacy_search_key(p_no))
   ORDER BY a.created_at, a.id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.tg_appointments_legacy_dup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IN ('cancelled','rescheduled','missed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.appointment_at IS NOT DISTINCT FROM OLD.appointment_at
     AND NEW.container_id IS NOT DISTINCT FROM OLD.container_id AND NEW.appointment_no IS NOT DISTINCT FROM OLD.appointment_no THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mrs_appt:' || NEW.transaction_id::text || ':'
                                                 || coalesce(NEW.container_id::text, '') || ':' || app.appt_minute(NEW.appointment_at)::text, 0));
  IF app.appt_duplicate(NEW.transaction_id, NEW.container_id, NEW.appointment_at, NEW.appointment_no, NEW.id) IS NOT NULL THEN
    PERFORM app.fail('MRS_DUPLICATE_APPOINTMENT', 'appointment');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_dup ON public.port_appointments;
CREATE TRIGGER trg_legacy_dup BEFORE INSERT OR UPDATE OF appointment_at, container_id, appointment_no, status ON public.port_appointments
  FOR EACH ROW EXECUTE FUNCTION app.tg_appointments_legacy_dup();

-- the race backstop (same key incl. the number): only on clean data — existing duplicates are never changed by a migration
DO $uidx$
BEGIN
  -- an earlier draft of this file keyed the raw number: replace it with the normalised key
  IF to_regclass('public.port_appointments_dup_uidx') IS NOT NULL THEN
    IF position('legacy_search_key' IN pg_get_indexdef(to_regclass('public.port_appointments_dup_uidx'))) = 0 THEN
      DROP INDEX public.port_appointments_dup_uidx;
    END IF;
  END IF;
  IF to_regclass('public.port_appointments_dup_uidx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.port_appointments a
                WHERE a.status NOT IN ('cancelled','rescheduled','missed')
                GROUP BY a.transaction_id, coalesce(a.container_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         app.appt_minute(a.appointment_at), coalesce(app.legacy_search_key(a.appointment_no), '')
               HAVING count(*) > 1) THEN
      RAISE NOTICE 'LEGACY TX: port_appointments has duplicate live appointments; port_appointments_dup_uidx not created (cancel the duplicates, then re-run this file)';
    ELSE
      CREATE UNIQUE INDEX port_appointments_dup_uidx ON public.port_appointments
        (transaction_id, coalesce(container_id, '00000000-0000-0000-0000-000000000000'::uuid), app.appt_minute(appointment_at),
         coalesce(app.legacy_search_key(appointment_no), ''))
        WHERE status NOT IN ('cancelled','rescheduled','missed');
    END IF;
  END IF;
END $uidx$;

-- ---------------------------------------------------------------------
-- 4. movements: appointment + trip + empty-return plan (legacy saveMovement)
-- ---------------------------------------------------------------------
ALTER TABLE public.transport_trips ADD COLUMN IF NOT EXISTS appointment_id uuid;
ALTER TABLE public.transport_trips DROP CONSTRAINT IF EXISTS transport_trips_appointment_fk;
ALTER TABLE public.transport_trips ADD CONSTRAINT transport_trips_appointment_fk
  FOREIGN KEY (appointment_id, org_id) REFERENCES public.port_appointments(id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS transport_trips_appointment_uidx ON public.transport_trips (appointment_id)
  WHERE appointment_id IS NOT NULL AND status <> 'cancelled';

ALTER TABLE public.drivers ADD COLUMN IF NOT EXISTS last_truck_id uuid;
ALTER TABLE public.drivers DROP CONSTRAINT IF EXISTS drivers_last_truck_fk;
ALTER TABLE public.drivers ADD CONSTRAINT drivers_last_truck_fk FOREIGN KEY (last_truck_id, org_id) REFERENCES public.trucks(id, org_id);
CREATE INDEX IF NOT EXISTS drivers_org_phone_idx ON public.drivers (org_id, phone) WHERE phone IS NOT NULL;

-- the legacy movement status of an appointment + trip (resolveMovementStatus_)
CREATE OR REPLACE FUNCTION app.movement_status(a public.port_appointments, r public.transport_trips) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
           WHEN r.id IS NOT NULL AND r.status = 'delivered' THEN 'delivered'
           WHEN (r.id IS NULL OR r.status = 'cancelled') AND (a.id IS NULL OR a.status IN ('cancelled','rescheduled','missed')) THEN 'cancelled'
           WHEN r.id IS NULL OR r.destination IS NULL OR r.cost_amount IS NULL OR r.sell_amount IS NULL THEN 'incomplete'
           ELSE 'registered' END
$$;

-- one movement as JSON; amounts only when p_fin (trip-finance role at the transaction's branch)
CREATE OR REPLACE FUNCTION app.movement_json(a public.port_appointments, r public.transport_trips, p_fin boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'appointment_id', a.id, 'trip_id', r.id, 'transaction_id', coalesce(a.transaction_id, r.transaction_id),
    'container_id', coalesce(a.container_id, r.container_id), 'container_no', c.container_no,
    'appointment_at', a.appointment_at, 'appointment_no', a.appointment_no, 'appointment_status', a.status,
    'terminal_party_id', a.terminal_party_id, 'window_minutes', a.window_minutes,
    'driver_id', coalesce(r.driver_id, a.driver_id), 'driver_name', d.full_name, 'driver_phone', d.phone,
    'truck_id', coalesce(r.truck_id, a.truck_id), 'truck_plate', k.plate_no, 'carrier_id', r.carrier_id,
    'origin', r.origin, 'destination', r.destination, 'trip_status', r.status, 'unloaded_at', r.unloaded_at, 'notes', r.notes,
    'movement_status', app.movement_status(a, r),
    'cost_amount', CASE WHEN p_fin THEN r.cost_amount END, 'sell_amount', CASE WHEN p_fin THEN r.sell_amount END,
    'return_deadline', c.return_deadline, 'return_location', c.return_location, 'return_yard_party_id', c.return_yard_party_id,
    'return_status', c.return_status,
    'created_at', least(a.created_at, r.created_at), 'updated_at', greatest(a.updated_at, r.updated_at))
    FROM (SELECT 1) one
    LEFT JOIN public.containers c ON c.id = coalesce(a.container_id, r.container_id)
    LEFT JOIN public.drivers d ON d.id = coalesce(r.driver_id, a.driver_id)
    LEFT JOIN public.trucks k ON k.id = coalesce(r.truck_id, a.truck_id)
$$;

-- driver find-or-create by phone (legacy upsertDriverDirectory_: the directory entry follows the last movement), truck
-- find-or-create by plate; returns {driver_id, driver_created, truck_id, truck_created}
CREATE OR REPLACE FUNCTION app.movement_fleet(p_tx public.transactions, p jsonb, p_carrier uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_driver uuid := app.puuid(p, 'driver_id'); v_truck uuid := app.puuid(p, 'truck_id');
  v_name text := app.ptext(p, 'driver_name', 120); v_phone_raw text := app.ptext(p, 'driver_phone', 30);
  v_plate_raw text := app.ptext(p, 'truck_plate', 30); v_phone text; v_plate text;
  v_dc boolean := false; v_tc boolean := false; v_d public.drivers; v_k public.trucks;
BEGIN
  IF v_phone_raw IS NOT NULL THEN
    v_phone := app.norm_sa_phone(v_phone_raw, false);
    IF v_phone IS NULL THEN PERFORM app.fail('MRS_INVALID', 'driver_phone'); END IF;
  END IF;
  IF v_driver IS NULL THEN
    IF v_name IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'driver_name'); END IF;
    IF char_length(v_name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'driver_name'); END IF;
    IF v_phone IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'driver_phone'); END IF;
    -- the stored phone may be in another spelling (+966 / 966 / spaces: the fleet registry keeps it as typed) →
    -- compare normalised (legacy normalizePhone_ on both sides); an exact match first
    SELECT * INTO v_d FROM public.drivers d
     WHERE d.org_id = p_tx.org_id AND d.is_active AND (d.phone = v_phone OR app.norm_sa_phone(d.phone, false) = v_phone)
     ORDER BY (d.phone = v_phone) DESC, d.updated_at DESC, d.id LIMIT 1;
    IF v_d.id IS NULL THEN
      INSERT INTO public.drivers (org_id, carrier_id, full_name, phone, created_by)
      VALUES (p_tx.org_id, p_carrier, v_name, v_phone, auth.uid()) RETURNING * INTO v_d;
      v_dc := true;
    ELSIF v_d.full_name IS DISTINCT FROM v_name THEN
      UPDATE public.drivers d SET full_name = v_name WHERE d.id = v_d.id RETURNING * INTO v_d;
    END IF;
    v_driver := v_d.id;
  ELSE
    SELECT * INTO v_d FROM public.drivers d WHERE d.id = v_driver AND d.org_id = p_tx.org_id;
    IF v_d.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'driver_id'); END IF;
    IF v_d.phone IS NULL AND v_phone IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'driver_phone'); END IF;
    IF v_phone IS NOT NULL AND app.norm_sa_phone(v_d.phone, false) IS DISTINCT FROM v_phone THEN
      UPDATE public.drivers d SET phone = v_phone WHERE d.id = v_d.id RETURNING * INTO v_d;
    END IF;
  END IF;
  IF v_truck IS NULL THEN
    IF v_plate_raw IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'truck_plate'); END IF;
    v_plate := app.norm_code(replace(translate(v_plate_raw, 'أإآ', 'ااا'), '-', ''));
    IF v_plate IS NULL OR char_length(v_plate) NOT BETWEEN 2 AND 20 THEN PERFORM app.fail('MRS_INVALID', 'truck_plate'); END IF;
    SELECT * INTO v_k FROM public.trucks k WHERE k.org_id = p_tx.org_id AND k.plate_no = v_plate;
    IF v_k.id IS NULL THEN
      INSERT INTO public.trucks (org_id, carrier_id, plate_no, created_by)
      VALUES (p_tx.org_id, p_carrier, v_plate, auth.uid()) RETURNING * INTO v_k;
      v_tc := true;
    ELSIF NOT v_k.is_active THEN
      PERFORM app.fail('MRS_INVALID', 'truck_plate');
    END IF;
    v_truck := v_k.id;
  END IF;
  PERFORM app.g3_check_fleet(p_tx.org_id, p_carrier, v_driver, v_truck);
  UPDATE public.drivers d SET last_truck_id = v_truck WHERE d.id = v_driver AND d.last_truck_id IS DISTINCT FROM v_truck;
  RETURN jsonb_build_object('driver_id', v_driver, 'driver_created', v_dc, 'truck_id', v_truck, 'truck_created', v_tc);
END $$;

-- save_movement(p_payload, p_idem_key) — legacy saveMovement: one form per container, writes the port appointment, its
-- transport trip and the container's empty-return plan in one server transaction.
--   payload: transaction_id (required); appointment_id | trip_id (edit an existing movement, else a new one);
--     container_id (required on a container transaction, refused on Ro-Ro); appointment_at (required for a new movement
--     except on Ro-Ro, where no appointment is created without it), appointment_no (TAS number), terminal_party_id,
--     window_minutes, appointment_status requested | confirmed;
--     driver_id | driver_name + driver_phone (05XXXXXXXX; find-or-create by phone), truck_id | truck_plate (find-or-create
--     by plate), carrier_id; origin, destination, notes; cost_amount (transport value) / sell_amount (organisation revenue)
--     — trip-finance roles only (MRS_FORBIDDEN cost);
--     movement_status registered (default) | delivered (needs destination + both amounts, given now or already on the
--     trip — legacy «تم النقل») | cancelled (edit only, needs reason); delivered_at (default now);
--     return_deadline, return_location, return_yard_party_id (the container's return plan, like set_container_return);
--     reason (required when an existing appointment's time changes = a reschedule, or when cancelling);
--     idempotent (true: a duplicate appointment returns the existing movement instead of MRS_DUPLICATE_APPOINTMENT).
--   → {movement, is_new, already_exists, transaction {id, ref, operational_status}, lifecycle_status, pending_containers,
--      follow_up_required, driver_id, driver_created, truck_id, truck_created}
-- Transport writers of the transaction's branch (g3_lock_tx: a cancelled transaction is refused).
CREATE OR REPLACE FUNCTION public.save_movement(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p jsonb := coalesce(p_payload, '{}'::jsonb) - 'idempotencyKey';
  v_txid uuid; v_tx public.transactions; v_replay jsonb; v_fin boolean;
  v_a public.port_appointments; v_a2 public.port_appointments; v_r public.transport_trips; v_r2 public.transport_trips;
  v_c public.containers; v_new boolean; v_dup uuid; v_ms text; v_reason text; v_af jsonb; v_tf jsonb; v_fleet jsonb;
  v_at timestamptz; v_no text; v_ctr uuid; v_del timestamptz; v_from text; v_carrier uuid; v_changed jsonb;
  v_yard uuid; v_loc text; v_res jsonb; v_st text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(v_p, ARRAY['transaction_id','appointment_id','trip_id','container_id','appointment_at','appointment_no',
    'terminal_party_id','window_minutes','appointment_status','driver_id','driver_name','driver_phone','truck_id','truck_plate',
    'carrier_id','origin','destination','notes','cost_amount','sell_amount','movement_status','delivered_at','return_deadline',
    'return_location','return_yard_party_id','reason','idempotent']);
  v_txid := app.puuid(v_p, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.transport_writer_roles());
  v_fin := app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.trip_finance_roles());
  IF (v_p ? 'cost_amount' OR v_p ? 'sell_amount') AND NOT v_fin THEN PERFORM app.fail('MRS_FORBIDDEN', 'cost'); END IF;
  v_replay := app.idem_begin('save_movement', p_idem_key, v_p, v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_ms := coalesce(app.ptext(v_p, 'movement_status', 20), 'registered');
  IF v_ms NOT IN ('registered','delivered','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'movement_status'); END IF;
  v_reason := app.ptext(v_p, 'reason', 500);
  v_carrier := app.puuid(v_p, 'carrier_id');
  IF v_p ? 'carrier_id' THEN PERFORM app.g3_check_party(v_tx.org_id, v_carrier, ARRAY['carrier'], 'carrier_id'); END IF;

  -- the movement being edited (by appointment or by trip), both of this transaction
  IF v_p ? 'appointment_id' AND app.puuid(v_p, 'appointment_id') IS NOT NULL THEN
    SELECT * INTO v_a FROM public.port_appointments a WHERE a.id = app.puuid(v_p, 'appointment_id') AND a.transaction_id = v_tx.id FOR UPDATE;
    IF v_a.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'appointment'); END IF;
    SELECT * INTO v_r FROM public.transport_trips r WHERE r.appointment_id = v_a.id AND r.status <> 'cancelled' FOR UPDATE;
  END IF;
  IF v_p ? 'trip_id' AND app.puuid(v_p, 'trip_id') IS NOT NULL THEN
    SELECT * INTO v_r2 FROM public.transport_trips r WHERE r.id = app.puuid(v_p, 'trip_id') AND r.transaction_id = v_tx.id FOR UPDATE;
    IF v_r2.id IS NULL OR (v_r.id IS NOT NULL AND v_r.id <> v_r2.id) OR (v_a.id IS NOT NULL AND v_r2.appointment_id IS DISTINCT FROM v_a.id) THEN
      PERFORM app.fail('MRS_NOT_FOUND', 'trip');
    END IF;
    v_r := v_r2;
    IF v_a.id IS NULL AND v_r.appointment_id IS NOT NULL THEN
      SELECT * INTO v_a FROM public.port_appointments a WHERE a.id = v_r.appointment_id FOR UPDATE;
    END IF;
  END IF;
  v_new := v_a.id IS NULL AND v_r.id IS NULL;
  IF v_ms = 'cancelled' AND v_new THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;

  -- the container: of this transaction; required on a container transaction, never on Ro-Ro
  IF v_p ? 'container_id' THEN v_ctr := app.puuid(v_p, 'container_id'); ELSE v_ctr := coalesce(v_a.container_id, v_r.container_id); END IF;
  IF v_tx.cargo_unit_type = 'roro' THEN
    IF v_ctr IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'container_id'); END IF;
  ELSIF v_ctr IS NULL AND v_ms <> 'cancelled' THEN
    PERFORM app.fail('MRS_REQUIRED', 'container_id');
  END IF;
  PERFORM app.g3_check_container(v_tx.id, v_ctr);

  -- ---- cancel a movement (legacy «ملغى»): the open appointment and the open trip, with the reason
  IF v_ms = 'cancelled' THEN
    IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
    IF v_r.id IS NOT NULL AND v_r.status = 'delivered' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'delivered'); END IF;
    IF v_a.id IS NOT NULL AND v_a.status IN ('requested','confirmed','missed') THEN
      v_from := v_a.status;
      UPDATE public.port_appointments a SET status = 'cancelled', status_reason = v_reason WHERE a.id = v_a.id RETURNING * INTO v_a;
      PERFORM app.appt_event(v_a, 'status', v_from, v_reason);
    END IF;
    IF v_r.id IS NOT NULL AND v_r.status IN ('planned','dispatched','loaded') THEN
      v_from := v_r.status;
      UPDATE public.transport_trips r SET status = 'cancelled', status_reason = v_reason WHERE r.id = v_r.id RETURNING * INTO v_r;
      PERFORM app.trip_event(v_r, 'status', v_from, v_reason);
    END IF;
    v_fleet := '{}'::jsonb;
  ELSE
    v_af := app.appt_fields(jsonb_strip_nulls(jsonb_build_object(
              'terminal_party_id', v_p -> 'terminal_party_id', 'window_minutes', v_p -> 'window_minutes',
              'appointment_at', v_p -> 'appointment_at', 'status', v_p -> 'appointment_status')), v_tx);
    v_at := (v_af ->> 'appointment_at')::timestamptz;
    IF v_p ? 'appointment_no' THEN
      v_no := app.ptext(v_p, 'appointment_no', 60);
      v_no := coalesce(app.norm_tas(v_no), app.norm_code(v_no));
      IF char_length(v_no) > 40 THEN PERFORM app.fail('MRS_TOO_LONG', 'appointment_no'); END IF;
    ELSE
      v_no := v_a.appointment_no;
    END IF;

    -- ---- a new appointment on a slot already held (legacy findDuplicateMovementRow_): checked before anything is
    -- written (review fix: the driver / truck registry was written first, then the idempotent replay said «nothing written»)
    IF v_a.id IS NULL AND v_at IS NOT NULL THEN
      v_dup := app.appt_duplicate(v_tx.id, v_ctr, v_at, v_no, NULL);
      IF v_dup IS NOT NULL THEN
        IF NOT app.pbool(v_p, 'idempotent') THEN PERFORM app.fail('MRS_DUPLICATE_APPOINTMENT', 'appointment'); END IF;
        -- legacy idempotent replay: the existing movement, nothing written
        SELECT * INTO v_a FROM public.port_appointments a WHERE a.id = v_dup;
        SELECT * INTO v_r FROM public.transport_trips r WHERE r.appointment_id = v_a.id AND r.status <> 'cancelled';
        SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
        v_res := jsonb_build_object('movement', app.movement_json(v_a, v_r, v_fin), 'is_new', false, 'already_exists', true,
          'transaction', jsonb_build_object('id', v_tx.id, 'ref', v_tx.ref, 'operational_status', v_tx.operational_status),
          'lifecycle_status', v_tx.operational_status,
          'pending_containers', coalesce((SELECT jsonb_agg(c.container_no ORDER BY c.container_no) FROM public.containers c
                                           WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived')), '[]'::jsonb),
          'driver_id', coalesce(v_r.driver_id, v_a.driver_id), 'driver_created', false,
          'truck_id', coalesce(v_r.truck_id, v_a.truck_id), 'truck_created', false);
        v_res := v_res || jsonb_build_object('follow_up_required', jsonb_array_length(v_res -> 'pending_containers') > 0
          AND app.code_sort('operational_status', v_tx.operational_status) >= app.code_sort('operational_status', 'transport'));
        RETURN app.idem_finish('save_movement', p_idem_key, v_res);
      END IF;
    END IF;

    -- ---- driver / truck (required, legacy validateMovement_)
    v_fleet := app.movement_fleet(v_tx, v_p - 'transaction_id', coalesce(v_carrier, v_r.carrier_id));

    -- ---- the appointment
    IF v_a.id IS NULL THEN
      IF v_at IS NULL AND v_tx.cargo_unit_type <> 'roro' AND v_r.id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'appointment_at'); END IF;
      IF v_at IS NOT NULL THEN
        INSERT INTO public.port_appointments (org_id, transaction_id, container_id, terminal_party_id, appointment_at, window_minutes,
                                              appointment_no, driver_id, truck_id, status, created_by)
        VALUES (v_tx.org_id, v_tx.id, v_ctr, (v_af ->> 'terminal_party_id')::uuid, v_at, (v_af ->> 'window_minutes')::int, v_no,
                (v_fleet ->> 'driver_id')::uuid, (v_fleet ->> 'truck_id')::uuid, coalesce(v_af ->> 'status', 'requested'), auth.uid())
        RETURNING * INTO v_a;
        PERFORM app.appt_event(v_a, 'created', NULL, NULL, jsonb_build_object('via', 'save_movement'));
      END IF;
    ELSE
      IF v_a.status NOT IN ('requested','confirmed') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_a.status); END IF;
      IF v_at IS NOT NULL AND v_at IS DISTINCT FROM v_a.appointment_at THEN
        -- a new time = a reschedule (G3.11: the old slot is kept as 'rescheduled', the trip follows the new row)
        IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
        v_from := v_a.status;
        UPDATE public.port_appointments a SET status = 'rescheduled', status_reason = v_reason WHERE a.id = v_a.id RETURNING * INTO v_a2;
        INSERT INTO public.port_appointments (org_id, transaction_id, container_id, terminal_party_id, appointment_at, window_minutes,
                                              appointment_no, driver_id, truck_id, status, rescheduled_from_id, created_by)
        VALUES (v_tx.org_id, v_tx.id, v_ctr,
                CASE WHEN v_af ? 'terminal_party_id' THEN (v_af ->> 'terminal_party_id')::uuid ELSE v_a.terminal_party_id END, v_at,
                CASE WHEN v_af ? 'window_minutes' THEN (v_af ->> 'window_minutes')::int ELSE v_a.window_minutes END,
                CASE WHEN v_p ? 'appointment_no' THEN v_no END,
                (v_fleet ->> 'driver_id')::uuid, (v_fleet ->> 'truck_id')::uuid, coalesce(v_af ->> 'status', 'requested'), v_a.id, auth.uid())
        RETURNING * INTO v_a;
        PERFORM app.appt_event(v_a2, 'rescheduled', v_from, v_reason, jsonb_build_object('replaced_by_id', v_a.id, 'via', 'save_movement'));
        PERFORM app.appt_event(v_a, 'created', NULL, NULL, jsonb_build_object('rescheduled_from_id', v_a2.id, 'via', 'save_movement'));
        IF v_r.id IS NOT NULL THEN SELECT * INTO v_r FROM public.transport_trips r WHERE r.id = v_r.id; END IF;
      ELSE
        v_from := v_a.status;
        IF v_af ->> 'status' = 'requested' AND v_a.status = 'confirmed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'backward'); END IF;
        v_a2 := v_a;
        UPDATE public.port_appointments a SET
          container_id      = v_ctr,
          terminal_party_id = CASE WHEN v_af ? 'terminal_party_id' THEN (v_af ->> 'terminal_party_id')::uuid ELSE a.terminal_party_id END,
          window_minutes    = CASE WHEN v_af ? 'window_minutes' THEN (v_af ->> 'window_minutes')::int ELSE a.window_minutes END,
          appointment_no    = v_no,
          driver_id         = (v_fleet ->> 'driver_id')::uuid,
          truck_id          = (v_fleet ->> 'truck_id')::uuid,
          status            = coalesce(v_af ->> 'status', a.status)
         WHERE a.id = v_a.id RETURNING * INTO v_a;
        SELECT jsonb_agg(k ORDER BY k) INTO v_changed
          FROM unnest(ARRAY['container_id','terminal_party_id','window_minutes','appointment_no','driver_id','truck_id','status']) k
         WHERE (to_jsonb(v_a) -> k) IS DISTINCT FROM (to_jsonb(v_a2) -> k);
        IF v_changed IS NOT NULL THEN
          IF v_a.status IS DISTINCT FROM v_from THEN
            PERFORM app.appt_event(v_a, 'status', v_from, NULL, jsonb_build_object('changed', v_changed, 'via', 'save_movement'));
          ELSE
            PERFORM app.appt_event(v_a, 'updated', v_from, NULL, jsonb_build_object('changed', v_changed, 'via', 'save_movement'));
          END IF;
        END IF;
      END IF;
    END IF;

    -- ---- the trip (value = cost_amount, organisation revenue = sell_amount)
    v_tf := app.trip_fields(jsonb_strip_nulls(jsonb_build_object(
              'origin', v_p -> 'origin', 'destination', v_p -> 'destination', 'notes', v_p -> 'notes',
              'cost_amount', v_p -> 'cost_amount', 'sell_amount', v_p -> 'sell_amount')), v_tx);
    IF v_r.id IS NULL THEN
      INSERT INTO public.transport_trips (org_id, transaction_id, container_id, leg_no, carrier_id, driver_id, truck_id, origin,
        destination, planned_at, notes, cost_amount, sell_amount, appointment_id, created_by)
      VALUES (v_tx.org_id, v_tx.id, v_ctr,
        least(50, (SELECT coalesce(max(t.leg_no), 0) + 1 FROM public.transport_trips t
                    WHERE t.transaction_id = v_tx.id AND t.container_id IS NOT DISTINCT FROM v_ctr)),
        v_carrier, (v_fleet ->> 'driver_id')::uuid, (v_fleet ->> 'truck_id')::uuid, v_tf ->> 'origin', v_tf ->> 'destination',
        v_a.appointment_at, v_tf ->> 'notes', (v_tf ->> 'cost_amount')::numeric, (v_tf ->> 'sell_amount')::numeric, v_a.id, auth.uid())
      RETURNING * INTO v_r;
      PERFORM app.trip_event(v_r, 'created', NULL, NULL, jsonb_build_object('via', 'save_movement'));
    ELSE
      IF v_r.status IN ('delivered','cancelled') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_r.status); END IF;
      v_r2 := v_r;
      UPDATE public.transport_trips r SET
        container_id = v_ctr,
        carrier_id   = CASE WHEN v_p ? 'carrier_id' THEN v_carrier ELSE r.carrier_id END,
        driver_id    = (v_fleet ->> 'driver_id')::uuid,
        truck_id     = (v_fleet ->> 'truck_id')::uuid,
        origin       = CASE WHEN v_tf ? 'origin' THEN v_tf ->> 'origin' ELSE r.origin END,
        destination  = CASE WHEN v_tf ? 'destination' THEN v_tf ->> 'destination' ELSE r.destination END,
        notes        = CASE WHEN v_tf ? 'notes' THEN v_tf ->> 'notes' ELSE r.notes END,
        planned_at   = coalesce(v_a.appointment_at, r.planned_at),
        cost_amount  = CASE WHEN v_tf ? 'cost_amount' THEN (v_tf ->> 'cost_amount')::numeric ELSE r.cost_amount END,
        sell_amount  = CASE WHEN v_tf ? 'sell_amount' THEN (v_tf ->> 'sell_amount')::numeric ELSE r.sell_amount END,
        appointment_id = coalesce(v_a.id, r.appointment_id)
       WHERE r.id = v_r.id RETURNING * INTO v_r;
      -- names of the changed fields only (the event never carries amounts)
      SELECT jsonb_agg(k ORDER BY k) INTO v_changed
        FROM unnest(ARRAY['container_id','carrier_id','driver_id','truck_id','origin','destination','notes','planned_at',
                          'cost_amount','sell_amount','appointment_id']) k
       WHERE (to_jsonb(v_r) -> k) IS DISTINCT FROM (to_jsonb(v_r2) -> k);
      IF v_changed IS NOT NULL THEN
        PERFORM app.trip_event(v_r, 'updated', v_r.status, NULL, jsonb_build_object('changed', v_changed, 'via', 'save_movement'));
      END IF;
    END IF;

    -- ---- delivered (legacy «تم النقل»: destination, value and revenue are required)
    IF v_ms = 'delivered' THEN
      IF v_r.destination IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'destination'); END IF;
      IF v_r.cost_amount IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'cost_amount'); END IF;
      IF v_r.sell_amount IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'sell_amount'); END IF;
      v_del := coalesce(app.pts(v_p, 'delivered_at'), now());
      IF v_del > now() + interval '1 day' OR (v_r.loaded_at IS NOT NULL AND v_del < v_r.loaded_at) THEN
        PERFORM app.fail('MRS_INVALID', 'delivered_at');
      END IF;
      v_from := v_r.status;
      UPDATE public.transport_trips r SET status = 'delivered', unloaded_at = v_del WHERE r.id = v_r.id RETURNING * INTO v_r;
      PERFORM app.trip_event(v_r, 'status', v_from, NULL, jsonb_build_object('at', v_del, 'via', 'save_movement'));
      -- legacy «تم النقل» closes the one movement record: the appointment is completed whether it was confirmed or
      -- still requested (review fix: a requested one stayed open and blocked cancel_transaction open_appointments)
      IF v_a.id IS NOT NULL AND v_a.status IN ('requested','confirmed') THEN
        v_from := v_a.status;
        UPDATE public.port_appointments a SET status = 'completed' WHERE a.id = v_a.id RETURNING * INTO v_a;
        PERFORM app.appt_event(v_a, 'status', v_from, NULL, jsonb_build_object('via', 'save_movement'));
      END IF;
      IF v_ctr IS NOT NULL THEN
        UPDATE public.containers c SET delivered_at = coalesce(c.delivered_at, v_del),
               operational_state = CASE WHEN c.operational_state IN ('expected','at_port','released','gated_out') THEN 'delivered'
                                        ELSE c.operational_state END
         WHERE c.id = v_ctr;
      END IF;
    ELSIF app.pts(v_p, 'delivered_at') IS NOT NULL THEN
      PERFORM app.fail('MRS_INVALID', 'delivered_at');
    END IF;

    -- ---- the container's empty-return plan (legacy: kept apart from the appointment; = set_container_return)
    IF v_ctr IS NOT NULL AND (v_p ? 'return_deadline' OR v_p ? 'return_location' OR v_p ? 'return_yard_party_id') THEN
      SELECT * INTO v_c FROM public.containers c WHERE c.id = v_ctr FOR UPDATE;
      IF v_c.return_status IN ('returned_verified','waived') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.return_status); END IF;
      v_yard := app.puuid(v_p, 'return_yard_party_id');
      v_loc := app.ptext(v_p, 'return_location', 120);
      IF v_p ? 'return_yard_party_id' THEN
        PERFORM app.g3_check_party(v_tx.org_id, v_yard, ARRAY['yard','terminal_operator'], 'return_yard_party_id');
        IF v_yard IS NOT NULL AND NOT (v_p ? 'return_location') AND v_c.return_location IS NULL THEN
          SELECT left(pa.name_ar, 120) INTO v_loc FROM public.parties pa WHERE pa.id = v_yard;
        END IF;
      END IF;
      UPDATE public.containers c SET
        return_deadline = CASE WHEN v_p ? 'return_deadline' THEN app.pdate(v_p, 'return_deadline') ELSE c.return_deadline END,
        return_yard_party_id = CASE WHEN v_p ? 'return_yard_party_id' THEN v_yard ELSE c.return_yard_party_id END,
        return_location = CASE WHEN v_p ? 'return_location' OR v_loc IS NOT NULL THEN v_loc ELSE c.return_location END
       WHERE c.id = v_c.id RETURNING * INTO v_c;
      INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
      VALUES (v_c.org_id, v_c.transaction_id, 'container', v_c.operational_state, v_c.operational_state, false, auth.uid(),
              jsonb_build_object('op', 'return_plan', 'container_id', v_c.id, 'container_no', v_c.container_no,
                                 'return_deadline', v_c.return_deadline, 'via', 'save_movement'));
    END IF;
  END IF;

  -- ---- lifecycle (legacy: a saved movement = «مرحلة النقل»; the triggers already moved it on insert)
  IF v_ms <> 'cancelled' AND v_r.id IS NOT NULL THEN v_st := app.advance_tx_status(v_tx.id, 'transport', 'movement'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
  v_res := jsonb_build_object('movement', app.movement_json(v_a, v_r, v_fin), 'is_new', v_new, 'already_exists', false,
    'transaction', jsonb_build_object('id', v_tx.id, 'ref', v_tx.ref, 'operational_status', v_tx.operational_status),
    'lifecycle_status', v_tx.operational_status,
    'pending_containers', coalesce((SELECT jsonb_agg(c.container_no ORDER BY c.container_no) FROM public.containers c
                                     WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived')), '[]'::jsonb),
    'driver_id', v_fleet -> 'driver_id', 'driver_created', coalesce((v_fleet ->> 'driver_created')::boolean, false),
    'truck_id', v_fleet -> 'truck_id', 'truck_created', coalesce((v_fleet ->> 'truck_created')::boolean, false));
  v_res := v_res || jsonb_build_object('follow_up_required',
    jsonb_array_length(v_res -> 'pending_containers') > 0
    AND app.code_sort('operational_status', v_tx.operational_status) >= app.code_sort('operational_status', 'transport'));
  RETURN app.idem_finish('save_movement', p_idem_key, v_res);
END $$;

-- list_movements(p_tx) — every appointment (latest of each reschedule chain: not 'rescheduled') with its trip, plus the trips
-- without an appointment; oldest first. Amounts only for trip-finance roles. Staff of the transaction's branch.
CREATE OR REPLACE FUNCTION public.list_movements(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_fin boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  v_fin := app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.trip_finance_roles());
  RETURN coalesce((
    SELECT jsonb_agg(m.j ORDER BY m.at, m.k)
      FROM (SELECT app.movement_json(a, r, v_fin) j, a.appointment_at at, a.id::text k
              FROM public.port_appointments a
              LEFT JOIN public.transport_trips r ON r.id = (SELECT x.id FROM public.transport_trips x WHERE x.appointment_id = a.id
                                                              ORDER BY (x.status = 'cancelled'), x.created_at DESC, x.id LIMIT 1)
             WHERE a.transaction_id = v_tx.id AND a.status <> 'rescheduled'
            UNION ALL
            SELECT app.movement_json(NULL::public.port_appointments, r, v_fin), coalesce(r.planned_at, r.created_at), r.id::text
              FROM public.transport_trips r
             WHERE r.transaction_id = v_tx.id AND r.appointment_id IS NULL) m), '[]'::jsonb);
END $$;

-- driver_directory(p_org, p_q) — legacy getDriverDirectory_ for the movement form: active drivers of the org by name or
-- phone (q ≥ 2 characters; empty q = the 50 most recently used), with the last truck → [{driver_id, full_name, phone,
-- carrier_id, last_truck_id, last_truck_plate}]. Staff of p_org.
CREATE OR REPLACE FUNCTION public.driver_directory(p_org uuid, p_q text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_q text := nullif(btrim(coalesce(p_q, '')), ''); v_digits text; v_qphone text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF char_length(v_q) > 60 THEN PERFORM app.fail('MRS_TOO_LONG', 'q'); END IF;
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN RETURN '[]'::jsonb; END IF;
  v_digits := nullif(regexp_replace(app.to_western(coalesce(v_q, '')), '[^0-9]', '', 'g'), '');
  v_qphone := app.norm_sa_phone(v_q, false);
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('driver_id', x.id, 'full_name', x.full_name, 'phone', x.phone, 'carrier_id', x.carrier_id,
                                        'last_truck_id', x.last_truck_id, 'last_truck_plate', x.plate_no) ORDER BY x.updated_at DESC, x.id)
      FROM (SELECT d.*, k.plate_no FROM public.drivers d LEFT JOIN public.trucks k ON k.id = d.last_truck_id
             WHERE d.org_id = p_org AND d.is_active
               AND (v_q IS NULL OR app.legacy_search_key(d.full_name) LIKE '%' || app.legacy_search_key(v_q) || '%'
                    OR (v_digits IS NOT NULL AND char_length(v_digits) >= 3
                        AND (d.phone LIKE '%' || v_digits || '%' OR app.norm_sa_phone(d.phone, false) LIKE '%' || v_digits || '%'))
                    OR (v_qphone IS NOT NULL AND app.norm_sa_phone(d.phone, false) = v_qphone))
             ORDER BY d.updated_at DESC, d.id LIMIT 50) x), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------
-- 5. ports: terminal operators for a port (legacy refreshOperatorOptions)
-- ---------------------------------------------------------------------
-- port_operators(p_org, p_port) — active terminal operators of the org that may work on a transaction at p_port (the rule of
-- trg_legacy_norm: mapped to that port, or mapped to no port at all), mapped ones first → [{party_id, name_ar, name_en,
-- mapped}]. p_port NULL = every active terminal operator. Staff of p_org.
CREATE OR REPLACE FUNCTION public.port_operators(p_org uuid, p_port text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF p_port IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customs_ports c WHERE c.code = p_port) THEN
    PERFORM app.fail('MRS_INVALID', 'port_code');
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('party_id', p.id, 'name_ar', p.name_ar, 'name_en', p.name_en, 'mapped', m.mapped)
                     ORDER BY m.mapped DESC, p.name_ar, p.id)
      FROM public.parties p
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.party_ports pp WHERE pp.party_id = p.id AND pp.is_active
                                            AND pp.port_code = p_port) AS mapped,
                                 EXISTS (SELECT 1 FROM public.party_ports pp WHERE pp.party_id = p.id AND pp.is_active) AS any_map) m
     WHERE p.org_id = p_org AND p.is_active AND 'terminal_operator' = ANY (p.kinds)
       AND (p_port IS NULL OR m.mapped OR NOT m.any_map)), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------
-- 6. public_track (20261113000100, re-created): body identical except (LEGACY TX) a cancelled transaction reports
--    cancelled = true, cancelled_at and the «ملغاة» label (operational_status stays 'closed'); its cancel event in the
--    timeline carries the same label.
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
    SELECT * INTO v_tx FROM public.transactions t WHERE t.request_id = v_req.id;
  ELSE
    SELECT * INTO v_tx FROM public.transactions t WHERE t.ref = v_ref AND t.tracking_token_hash = v_hash LIMIT 1;
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
-- 7. column grant: transport_trips (+ appointment_id; cost / sell stay outside, fail closed)
-- ---------------------------------------------------------------------
DO $cols$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'transport_trips'
     AND NOT (c.column_name = ANY (ARRAY['cost_amount','cost_currency','sell_amount','sell_currency','cost_basis']));
  EXECUTE format('GRANT SELECT (%s) ON public.transport_trips TO authenticated', v_cols);
END $cols$;

-- ---------------------------------------------------------------------
-- 8. function privileges
-- ---------------------------------------------------------------------
-- internal helpers / definer triggers: SECURITY DEFINER code only
REVOKE EXECUTE ON FUNCTION app.container_bl_key(uuid, text), app.auto_lifecycle_on(),
  app.tx_dup_conflicts(uuid, uuid, text, text, text, text[]), app.tx_dup_lock(uuid, text),
  app.tg_transactions_legacy_dup(), app.tg_containers_legacy_dup(), app.tg_bills_of_lading_legacy_dup(),
  app.advance_tx_status(uuid, text, text),
  app.tg_declarations_legacy_tx(), app.tg_appointments_legacy_tx(), app.tg_trips_legacy_tx(), app.tg_containers_legacy_tx(),
  app.tg_transactions_legacy_billed(), app.appt_duplicate(uuid, uuid, timestamptz, text, uuid), app.tg_appointments_legacy_dup(),
  app.movement_status(public.port_appointments, public.transport_trips),
  app.movement_json(public.port_appointments, public.transport_trips, boolean),
  app.movement_fleet(public.transactions, jsonb, uuid)
FROM PUBLIC, anon, authenticated, service_role;
-- the pure minute helper (used by an index expression): signed-in users and the Edge Functions, never anon
REVOKE EXECUTE ON FUNCTION app.appt_minute(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.appt_minute(timestamptz) TO authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.check_tx_duplicates(uuid, jsonb), public.tx_lifecycle(uuid), public.save_movement(jsonb, uuid),
  public.list_movements(uuid), public.driver_directory(uuid, text), public.port_operators(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_tx_duplicates(uuid, jsonb), public.tx_lifecycle(uuid), public.save_movement(jsonb, uuid),
  public.list_movements(uuid), public.driver_directory(uuid, text), public.port_operators(uuid, text)
TO authenticated;
-- re-created public_track: CREATE OR REPLACE keeps its privileges (anon + authenticated)
