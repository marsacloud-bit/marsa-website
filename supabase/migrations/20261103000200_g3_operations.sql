-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261103000200 — G3 migration B: operations
-- (docs/online/G3_SPEC.md items 7–12). Builds on 20261103000100 (migration A).
--
-- 7.  document_requirements (org rules: operation / mode / port → document kind
--     needed before a stage) + app.seed_document_requirements(p_org) (existing
--     orgs here, new orgs from platform_create_org) + tx_checklist(p_tx).
--     set_transaction_status refuses a forward move into (or past) stage S while
--     a mandatory requirement of S is missing / unreviewed (MRS_DOCS_MISSING,
--     detail = kinds). Senior roles override EXPLICITLY (new last parameter
--     p_docs_override = true) with the reason (p_note) → an internal
--     docs_override event. transaction_completeness uses the rules.
-- 8.  port_appointments + create_appointment / reschedule_appointment (new row,
--     old one kept as 'rescheduled') / set_appointment_status.
-- 9.  transport_trips (legs) + create_trip / update_trip / set_trip_status.
--     cost / sell columns are outside the API SELECT grant; trip_finance(p_ids)
--     returns them to finance roles + operations_manager / branch_manager /
--     supervisor / admin only (transport_staff and clients never see them).
-- 10. containers: return_yard_party_id, return_instruction_document_id (the
--     Return Note = instruction, never proof), evidence_received_at +
--     set_container_return(p_container, p_payload). The proof rule is unchanged
--     (returned_verified needs a confirmed empty_return_receipt).
-- 11. operational_exceptions + create_exception / resolve_exception.
--     cancel_declaration (recreated from A) adds a declaration_cancelled exception.
-- 12. operational_alerts + refresh_alerts(p_org) (idempotent upsert by
--     dedupe_key, auto-resolve when the cause is gone; staff: once a minute per
--     org; pg_cron every 15 min when the extension exists) + list_alerts /
--     ack_alert / resolve_alert. Alerts are branch-scoped through their
--     transaction; a branch move hands active alerts to the new branch.
--
-- Client portal: only client-visible events are added (appointment confirmed:
-- time / window / container number + an opaque appointment_ref; a confirmed slot
-- that is rescheduled / cancelled / missed later is withdrawn, a completed one
-- says so). Appointments, trips, exceptions, alerts and requirements are
-- staff-only tables.
-- Recreated from their latest definitions (bodies otherwise unchanged):
--   set_transaction_status (0300) + the requirement gate;
--   platform_create_org (0200) + the requirement seed;
--   cancel_declaration, transaction_completeness (A) + exception / requirements.
-- Migration A creates its own cancel_declaration / transaction_completeness only
-- while this file is not applied, so re-running A alone keeps these versions.
-- Re-running 20261102000200 / 0300 alone after this file re-creates an older
-- set_transaction_status overload: re-run this file afterwards (it drops them).
-- Errors: new code MRS_DOCS_MISSING; otherwise existing codes.
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

INSERT INTO public.schema_versions (version, name) VALUES ('20261103000200', 'g3_operations')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('requirement_status','satisfied',1,'مستوفى','Satisfied',false),
  ('requirement_status','unreviewed',2,'مرفوع بانتظار المراجعة','Uploaded, not reviewed',false),
  ('requirement_status','missing',3,'ناقص','Missing',false),
  ('requirement_status','not_applicable',4,'لا ينطبق','Not applicable',false),
  ('appointment_status','requested',1,'مطلوب','Requested',true),
  ('appointment_status','confirmed',2,'مؤكد','Confirmed',true),
  ('appointment_status','completed',3,'تم','Completed',true),
  ('appointment_status','missed',4,'فائت','Missed',false),
  ('appointment_status','cancelled',5,'ملغى','Cancelled',false),
  ('appointment_status','rescheduled',6,'أُعيدت جدولته','Rescheduled',false),
  ('trip_status','planned',1,'مخطط','Planned',false),
  ('trip_status','dispatched',2,'أُرسلت الشاحنة','Dispatched',false),
  ('trip_status','loaded',3,'تم التحميل','Loaded',false),
  ('trip_status','delivered',4,'تم التسليم','Delivered',false),
  ('trip_status','cancelled',5,'ملغاة','Cancelled',false),
  ('cost_basis','agreed',1,'سعر متفق عليه','Agreed',false),
  ('cost_basis','estimated',2,'تقديري','Estimated',false),
  ('cost_basis','invoice',3,'حسب الفاتورة','Per invoice',false),
  ('exception_kind','declaration_cancelled',1,'إلغاء بيان جمركي','Declaration cancelled',false),
  ('exception_kind','demurrage',2,'أرضيات / غرامة تأخير','Demurrage',false),
  ('exception_kind','detention_extension',3,'تمديد مهلة الحاوية','Detention extension',false),
  ('exception_kind','customs_rejection',4,'رفض جمركي','Customs rejection',false),
  ('exception_kind','inspection',5,'معاينة / كشف','Inspection',false),
  ('exception_kind','repair_fee',6,'رسوم إصلاح','Repair fee',false),
  ('exception_kind','cleaning_fee',7,'رسوم تنظيف','Cleaning fee',false),
  ('exception_kind','appointment_change',8,'تغيير موعد','Appointment change',false),
  ('exception_kind','transport_change',9,'تغيير في النقل','Transport change',false),
  ('exception_kind','other',10,'أخرى','Other',false),
  ('exception_source','manual',1,'إدخال يدوي','Manual',false),
  ('exception_source','document',2,'من مستند','From a document',false),
  ('exception_source','email',3,'من بريد إلكتروني','From an e-mail',false),
  ('exception_source','system',4,'تلقائي من النظام','System',false),
  ('exception_status','open',1,'مفتوح','Open',false),
  ('exception_status','in_progress',2,'قيد المعالجة','In progress',false),
  ('exception_status','resolved',3,'تمت المعالجة','Resolved',false),
  ('exception_status','waived',4,'تم التنازل','Waived',false),
  ('alert_kind','docs_missing',1,'مستندات ناقصة','Documents missing',false),
  ('alert_kind','appointment_soon',2,'موعد قريب','Appointment soon',false),
  ('alert_kind','appointment_missed',3,'موعد فائت','Appointment missed',false),
  ('alert_kind','empty_return_due',4,'موعد إرجاع الفارغ قريب','Empty return due',false),
  ('alert_kind','empty_return_overdue',5,'تأخر إرجاع الفارغ','Empty return overdue',false),
  ('alert_kind','exception_open',6,'استثناء مفتوح','Open exception',false),
  ('alert_kind','declaration_stalled',7,'بيان جمركي متوقف','Declaration stalled',false),
  ('alert_severity','critical',1,'حرج','Critical',false),
  ('alert_severity','warning',2,'تحذير','Warning',false),
  ('alert_severity','info',3,'للعلم','Info',false),
  ('alert_status','open',1,'مفتوح','Open',false),
  ('alert_status','acknowledged',2,'تم الاطلاع','Acknowledged',false),
  ('alert_status','resolved',3,'مغلق','Resolved',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. small helpers
-- ---------------------------------------------------------------------
-- optional ISO timestamp field (YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH[:MM]]) from a payload
CREATE OR REPLACE FUNCTION app.pts(p jsonb, k text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE s text := nullif(btrim(app.to_western(coalesce(p ->> k, ''))), '');
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'string'
     OR s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$' THEN
    PERFORM app.fail('MRS_INVALID', k);
  END IF;
  BEGIN
    RETURN s::timestamptz;
  EXCEPTION WHEN others THEN
    PERFORM app.fail('MRS_INVALID', k);
  END;
  RETURN NULL;
END $$;

-- senior operational roles (corrections, overrides, waivers)
CREATE OR REPLACE FUNCTION app.senior_ops_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['operations_manager','branch_manager','supervisor','admin']
$$;
-- who may read / write trip cost and sell amounts
CREATE OR REPLACE FUNCTION app.trip_finance_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accountant','accounts_manager','operations_manager','branch_manager','supervisor','admin']
$$;

-- a party of the org with one of p_kinds (active) — MRS_INVALID <field> otherwise
CREATE OR REPLACE FUNCTION app.g3_check_party(p_org uuid, p_id uuid, p_kinds text[], p_field text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parties pa
       WHERE pa.id = p_id AND pa.org_id = p_org AND pa.is_active AND pa.kinds && p_kinds) THEN
    PERFORM app.fail('MRS_INVALID', p_field);
  END IF;
END $$;

-- driver / truck: active, same org, and (when both are known) of the trip's carrier or the own fleet
CREATE OR REPLACE FUNCTION app.g3_check_fleet(p_org uuid, p_carrier uuid, p_driver uuid, p_truck uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_driver IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.drivers d
       WHERE d.id = p_driver AND d.org_id = p_org AND d.is_active
         AND (p_carrier IS NULL OR d.carrier_id IS NULL OR d.carrier_id = p_carrier)) THEN
    PERFORM app.fail('MRS_INVALID', 'driver_id');
  END IF;
  IF p_truck IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.trucks t
       WHERE t.id = p_truck AND t.org_id = p_org AND t.is_active
         AND (p_carrier IS NULL OR t.carrier_id IS NULL OR t.carrier_id = p_carrier)) THEN
    PERFORM app.fail('MRS_INVALID', 'truck_id');
  END IF;
END $$;

-- a container of THIS transaction (or NULL)
CREATE OR REPLACE FUNCTION app.g3_check_container(p_tx uuid, p_container uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_container IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.containers c
       WHERE c.id = p_container AND c.transaction_id = p_tx) THEN
    PERFORM app.fail('MRS_INVALID', 'container_id');
  END IF;
END $$;

-- a non-voided document of THIS transaction (or NULL)
CREATE OR REPLACE FUNCTION app.g3_check_document(p_tx uuid, p_doc uuid, p_field text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.documents d
       WHERE d.id = p_doc AND d.transaction_id = p_tx AND d.voided_at IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', p_field);
  END IF;
END $$;

-- children of a transaction point at one of ITS containers: (container_id, transaction_id) FK target
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'containers_id_tx_uniq' AND conrelid = 'public.containers'::regclass) THEN
    ALTER TABLE public.containers ADD CONSTRAINT containers_id_tx_uniq UNIQUE (id, transaction_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. document requirements (G3.10)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_requirements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  operation          text CHECK (operation IN ('import','export')),        -- NULL = any
  mode               text CHECK (mode IN ('sea','air','land')),            -- NULL = any
  port               text CHECK (char_length(port) BETWEEN 1 AND 80),      -- NULL = any port (import: discharge, export: loading)
  document_kind      text NOT NULL CONSTRAINT document_requirements_kind_chk CHECK (document_kind = ANY (app.document_kinds())),
  required_for_stage text NOT NULL CHECK (required_for_stage IN ('in_progress','customs_declaration','appointment','transport',
                       'empty_return','operationally_complete','under_billing','billed','closed')),
  is_optional        boolean NOT NULL DEFAULT false,                       -- shown in the checklist, never blocks
  is_active          boolean NOT NULL DEFAULT true,
  note               text CHECK (char_length(note) <= 500),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.document_requirements IS 'G3.10 per-org rules: which document kind (confirmed classification) is needed before an operational stage. Blocks only that forward move (set_transaction_status, MRS_DOCS_MISSING).';
CREATE UNIQUE INDEX IF NOT EXISTS document_requirements_rule_uidx ON public.document_requirements
  (org_id, coalesce(operation, ''), coalesce(mode, ''), lower(coalesce(port, '')), document_kind, required_for_stage);

CREATE OR REPLACE FUNCTION app.tg_document_requirements_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.port := nullif(btrim(coalesce(NEW.port, '')), '');
  NEW.note := nullif(btrim(coalesce(NEW.note, '')), '');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.document_requirements;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.document_requirements
  FOR EACH ROW EXECUTE FUNCTION app.tg_document_requirements_before();

-- sensible defaults for an org that has no rules yet (an org that edited or
-- deactivated its rules keeps them: nothing is re-added). Returns rows added.
CREATE OR REPLACE FUNCTION app.seed_document_requirements(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  IF p_org IS NULL OR EXISTS (SELECT 1 FROM public.document_requirements r WHERE r.org_id = p_org) THEN RETURN 0; END IF;
  INSERT INTO public.document_requirements (org_id, operation, mode, document_kind, required_for_stage, is_optional, note)
  SELECT p_org, d.op, d.mode, d.kind, d.stage, d.opt, d.note FROM (VALUES
    ('import','sea','bill_of_lading','customs_declaration',false,NULL),
    ('import','sea','commercial_invoice','customs_declaration',false,NULL),
    ('import','sea','packing_list','customs_declaration',false,NULL),
    ('import','sea','certificate_of_origin','customs_declaration',true,'حسب بلد المنشأ والاتفاقيات'),
    ('import','sea','delivery_order','appointment',false,NULL),
    ('import','sea','empty_return_receipt','operationally_complete',false,'لا ينطبق على معاملة بلا حاويات'),
    ('import','air','bill_of_lading','customs_declaration',false,'بوليصة الشحن الجوي (AWB)'),
    ('import','air','commercial_invoice','customs_declaration',false,NULL),
    ('import','air','packing_list','customs_declaration',false,NULL),
    ('import','air','certificate_of_origin','customs_declaration',true,'حسب بلد المنشأ والاتفاقيات'),
    ('import','land','commercial_invoice','customs_declaration',false,NULL),
    ('import','land','packing_list','customs_declaration',false,NULL),
    ('import','land','certificate_of_origin','customs_declaration',true,'حسب بلد المنشأ والاتفاقيات'),
    ('export',NULL,'commercial_invoice','customs_declaration',false,NULL),
    ('export',NULL,'packing_list','customs_declaration',false,NULL)
  ) AS d(op, mode, kind, stage, opt, note);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- requirement items of one transaction (rules matching operation / mode / port, one item per kind + stage).
-- status: satisfied (a non-voided document confirmed / reclassified to the kind) | unreviewed (declared or
-- suggested, not confirmed) | missing | not_applicable (empty_return_receipt when no container needs one).
CREATE OR REPLACE FUNCTION app.tx_requirements(p_tx uuid)
RETURNS TABLE (document_kind text, required_for_stage text, stage_sort int, is_optional boolean, status text,
               document_ids uuid[], requirement_ids uuid[], label_ar text, label_en text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH t AS (
    SELECT x.id, x.org_id, x.operation, x.mode, x.container_count,
           lower(btrim(CASE WHEN x.operation = 'import' THEN x.port_of_discharge ELSE x.port_of_loading END)) AS port
      FROM public.transactions x WHERE x.id = p_tx),
  r AS (
    SELECT q.document_kind AS kind, q.required_for_stage AS stage, bool_and(q.is_optional) AS opt,
           array_agg(q.id ORDER BY q.id) AS ids
      FROM public.document_requirements q JOIN t ON q.org_id = t.org_id
     WHERE q.is_active
       AND (q.operation IS NULL OR q.operation = t.operation)
       AND (q.mode IS NULL OR q.mode = t.mode)
       AND (q.port IS NULL OR lower(q.port) = t.port)
     GROUP BY q.document_kind, q.required_for_stage),
  c AS (
    -- declared-but-unregistered containers or any non-waived one still need a receipt
    SELECT coalesce(t.container_count, 0) > (SELECT count(*) FROM public.containers k WHERE k.transaction_id = t.id)
           OR EXISTS (SELECT 1 FROM public.containers k WHERE k.transaction_id = t.id AND k.return_status <> 'waived') AS needs_receipt
      FROM t)
  SELECT r.kind, r.stage, app.code_sort('operational_status', r.stage), r.opt,
         CASE WHEN r.kind = 'empty_return_receipt' AND NOT c.needs_receipt THEN 'not_applicable'
              WHEN s.ids IS NOT NULL THEN 'satisfied'
              WHEN u.ids IS NOT NULL THEN 'unreviewed'
              ELSE 'missing' END,
         coalesce(s.ids, u.ids, '{}'::uuid[]), r.ids,
         coalesce(l.label_ar, r.kind), coalesce(l.label_en, r.kind)
    FROM r CROSS JOIN c CROSS JOIN t
    LEFT JOIN LATERAL (SELECT array_agg(d.id ORDER BY d.uploaded_at, d.id) AS ids FROM public.documents d
                        WHERE d.transaction_id = t.id AND d.voided_at IS NULL AND d.classification = r.kind
                          AND d.classification_status IN ('confirmed','reclassified')) s ON true
    LEFT JOIN LATERAL (SELECT array_agg(d.id ORDER BY d.uploaded_at, d.id) AS ids FROM public.documents d
                        WHERE d.transaction_id = t.id AND d.voided_at IS NULL
                          AND d.classification_status NOT IN ('confirmed','reclassified')
                          AND (d.classification = r.kind OR (d.classification IS NULL AND d.kind = r.kind))) u ON true
    LEFT JOIN public.status_labels l ON l.domain = 'document_kind' AND l.code = r.kind
   ORDER BY 3, 4, 1
$$;

-- tx_checklist(p_tx) — requirement items for the stages of this transaction (staff of its branch).
-- blocking = mandatory, not satisfied, for a stage still ahead.
CREATE OR REPLACE FUNCTION public.tx_checklist(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_cur int; v_next text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_cur := app.code_sort('operational_status', v_tx.operational_status);
  SELECT l.code INTO v_next FROM public.status_labels l
   WHERE l.domain = 'operational_status' AND l.sort > v_cur ORDER BY l.sort LIMIT 1;
  RETURN jsonb_build_object(
    'transaction_id', v_tx.id, 'stage', v_tx.operational_status, 'next_stage', v_next,
    'configured', EXISTS (SELECT 1 FROM public.document_requirements r WHERE r.org_id = v_tx.org_id),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'document_kind', x.document_kind, 'label_ar', x.label_ar, 'label_en', x.label_en,
        'required_for_stage', x.required_for_stage, 'stage_label_ar', sl.label_ar, 'stage_label_en', sl.label_en,
        'optional', x.is_optional, 'status', x.status, 'document_ids', to_jsonb(x.document_ids),
        'requirement_ids', to_jsonb(x.requirement_ids),
        'blocking', NOT x.is_optional AND x.status IN ('missing','unreviewed') AND x.stage_sort > v_cur)
        ORDER BY x.stage_sort, x.is_optional, x.document_kind)
      FROM app.tx_requirements(v_tx.id) x
      LEFT JOIN public.status_labels sl ON sl.domain = 'operational_status' AND sl.code = x.required_for_stage), '[]'::jsonb),
    'blocking_next', coalesce((SELECT jsonb_agg(x.document_kind ORDER BY x.document_kind)
      FROM app.tx_requirements(v_tx.id) x
     WHERE x.required_for_stage = v_next AND NOT x.is_optional AND x.status IN ('missing','unreviewed')), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------
-- 3. set_transaction_status — body = 20261102000300 (idempotency, branch_manager);
--    only the document-requirement gate (+ its override event) is new. The override is EXPLICIT:
--    p_docs_override = true (sent only by the override dialog) + a reason (p_note) + a senior role.
--    A note alone (backward reason, stage skip, routine note) never bypasses the gate.
--    Signature change → the 4-argument version (and a re-created 3-argument one) are dropped first.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text);
DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text, uuid);
CREATE OR REPLACE FUNCTION public.set_transaction_status(
  p_transaction_id uuid, p_status text, p_note text DEFAULT NULL, p_idem_key uuid DEFAULT NULL,
  p_docs_override boolean DEFAULT false) RETURNS jsonb
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
  v_replay jsonb;
  v_missing text[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('set_transaction_status', p_idem_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'status', p_status, 'note', p_note)
    || CASE WHEN coalesce(p_docs_override, false) THEN jsonb_build_object('docs_override', true) ELSE '{}'::jsonb END, v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
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

  -- G3.10 document requirements: a forward move into (or past) a stage whose mandatory documents are
  -- missing / unreviewed is refused for this move only. Senior roles may override EXPLICITLY
  -- (p_docs_override) with the reason (p_note).
  IF NOT v_backward THEN
    SELECT array_agg(DISTINCT x.document_kind ORDER BY x.document_kind) INTO v_missing
      FROM app.tx_requirements(v_tx.id) x
     WHERE NOT x.is_optional AND x.status IN ('missing','unreviewed') AND x.stage_sort > v_from AND x.stage_sort <= v_to;
    IF v_missing IS NOT NULL THEN
      IF NOT coalesce(p_docs_override, false) THEN PERFORM app.fail('MRS_DOCS_MISSING', array_to_string(v_missing, ',')); END IF;
      IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.senior_ops_roles()) THEN
        PERFORM app.fail('MRS_FORBIDDEN', 'docs_override');
      END IF;
      IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'docs_override'); END IF;
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
  IF v_missing IS NOT NULL THEN
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor, payload)
    VALUES (v_tx.org_id, v_tx.id, 'docs_override', v_tx.operational_status, p_status, v_note, false, auth.uid(),
            jsonb_build_object('for_event', v_ev, 'kinds', to_jsonb(v_missing)));
  END IF;
  RETURN app.idem_finish('set_transaction_status', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'from', v_tx.operational_status,
                       'to', p_status, 'event_id', v_ev, 'docs_override', to_jsonb(v_missing)));
END $$;

-- ---------------------------------------------------------------------
-- 4. platform_create_org — body = 20261102000200; + default document requirements
-- ---------------------------------------------------------------------
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
  -- G3.10: default document requirements (the org admin edits them later)
  PERFORM app.seed_document_requirements(v_org);
  SELECT * INTO v_inv FROM app.create_invitation(v_org, v_email, 'admin', NULL, NULL);

  -- the stored replay copy never holds the token
  v_res := jsonb_build_object('org_id', v_org, 'slug', v_slug, 'branch_id', v_branch, 'invitation_id', v_inv.id,
                              'email', v_email, 'expires_at', v_inv.expires_at,
                              'token', NULL, 'accept_path', NULL, 'token_shown', true);
  PERFORM app.idem_finish('platform_create_org', v_key, v_res);
  RETURN v_res || jsonb_build_object('token', v_inv.token, 'accept_path', 'login.html?invite=' || v_inv.token,
                                     'token_shown', false);
END $$;

-- existing orgs get the defaults once (an org that already has rules is left alone)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT o.id FROM public.organizations o ORDER BY o.created_at, o.id LOOP
    PERFORM app.seed_document_requirements(r.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 5. port appointments (G3.11)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.port_appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  transaction_id      uuid NOT NULL,
  container_id        uuid,
  terminal_party_id   uuid,
  appointment_at      timestamptz NOT NULL,
  window_minutes      int CHECK (window_minutes BETWEEN 0 AND 1440),
  appointment_no      text CHECK (char_length(appointment_no) <= 40),
  driver_id           uuid,
  truck_id            uuid,
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN
                        ('requested','confirmed','completed','missed','cancelled','rescheduled')),
  status_reason       text CHECK (char_length(status_reason) <= 500),
  rescheduled_from_id uuid,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT port_appointments_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT port_appointments_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT port_appointments_terminal_fk FOREIGN KEY (terminal_party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT port_appointments_driver_fk FOREIGN KEY (driver_id, org_id) REFERENCES public.drivers(id, org_id),
  CONSTRAINT port_appointments_truck_fk FOREIGN KEY (truck_id, org_id) REFERENCES public.trucks(id, org_id),
  CONSTRAINT port_appointments_reason_chk CHECK (status NOT IN ('missed','cancelled','rescheduled') OR status_reason IS NOT NULL),
  UNIQUE (id, org_id)
);
ALTER TABLE public.port_appointments DROP CONSTRAINT IF EXISTS port_appointments_rescheduled_fk;
ALTER TABLE public.port_appointments ADD CONSTRAINT port_appointments_rescheduled_fk
  FOREIGN KEY (rescheduled_from_id, org_id) REFERENCES public.port_appointments(id, org_id);
COMMENT ON TABLE public.port_appointments IS 'G3.11 terminal appointments. A reschedule adds a NEW row (rescheduled_from_id) and marks the old one rescheduled: nothing is lost.';
-- a row is rescheduled at most once (the chain is linear)
CREATE UNIQUE INDEX IF NOT EXISTS port_appointments_resched_uidx ON public.port_appointments (rescheduled_from_id) WHERE rescheduled_from_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS port_appointments_tx_idx ON public.port_appointments (transaction_id, appointment_at);
CREATE INDEX IF NOT EXISTS port_appointments_open_idx ON public.port_appointments (org_id, appointment_at) WHERE status IN ('requested','confirmed');

CREATE OR REPLACE FUNCTION app.appt_json(a public.port_appointments) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', a.id, 'org_id', a.org_id, 'transaction_id', a.transaction_id, 'container_id', a.container_id,
    'terminal_party_id', a.terminal_party_id, 'appointment_at', a.appointment_at, 'window_minutes', a.window_minutes,
    'appointment_no', a.appointment_no, 'driver_id', a.driver_id, 'truck_id', a.truck_id, 'status', a.status,
    'status_reason', a.status_reason, 'rescheduled_from_id', a.rescheduled_from_id, 'created_by', a.created_by,
    'created_at', a.created_at, 'updated_at', a.updated_at)
$$;

-- appointment event. The client ALSO gets: the confirmation (time, window, container number) and, when a
-- confirmed slot later stops being valid, its withdrawal (rescheduled / cancelled / missed) or completion.
-- appointment_ref is opaque (derived from the id; it opens nothing) so the portal can pair them.
CREATE OR REPLACE FUNCTION app.appt_event(a public.port_appointments, p_op text, p_from text, p_note text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ref text := left(md5('appt:' || a.id::text), 16); v_cno text; v_op text;
BEGIN
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor, payload)
  VALUES (a.org_id, a.transaction_id, 'appointment', p_from, a.status, left(p_note, 2000), false, auth.uid(),
          jsonb_build_object('op', p_op, 'appointment_id', a.id, 'container_id', a.container_id,
                             'appointment_at', a.appointment_at) || coalesce(p_extra, '{}'::jsonb));
  v_op := CASE WHEN a.status = 'confirmed' AND p_from IS DISTINCT FROM 'confirmed' THEN 'confirmed'
               WHEN p_from = 'confirmed' AND a.status IN ('rescheduled','cancelled','missed') THEN 'withdrawn'
               WHEN p_from = 'confirmed' AND a.status = 'completed' THEN 'completed' END;
  IF v_op IS NOT NULL THEN
    SELECT c.container_no INTO v_cno FROM public.containers c WHERE c.id = a.container_id;
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
    VALUES (a.org_id, a.transaction_id, 'appointment', NULL, CASE WHEN v_op = 'withdrawn' THEN NULL ELSE a.status END,
            true, auth.uid(),
            jsonb_build_object('op', v_op, 'appointment_ref', v_ref, 'appointment_at', a.appointment_at,
                               'window_minutes', a.window_minutes, 'container_no', v_cno));
  END IF;
END $$;

-- payload → normalized appointment fields (keys present only), references checked against p_tx
CREATE OR REPLACE FUNCTION app.appt_fields(p jsonb, p_tx public.transactions) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; n numeric; s text;
BEGIN
  IF p ? 'container_id' THEN
    v := v || jsonb_build_object('container_id', app.puuid(p, 'container_id'));
    PERFORM app.g3_check_container(p_tx.id, (v ->> 'container_id')::uuid);
  END IF;
  IF p ? 'terminal_party_id' THEN
    v := v || jsonb_build_object('terminal_party_id', app.puuid(p, 'terminal_party_id'));
    PERFORM app.g3_check_party(p_tx.org_id, (v ->> 'terminal_party_id')::uuid, ARRAY['terminal_operator','yard'], 'terminal_party_id');
  END IF;
  IF p ? 'appointment_at' THEN v := v || jsonb_build_object('appointment_at', app.pts(p, 'appointment_at')); END IF;
  IF p ? 'window_minutes' THEN
    n := app.pnum(p, 'window_minutes', 1440);
    IF n IS NOT NULL AND n <> trunc(n) THEN PERFORM app.fail('MRS_INVALID', 'window_minutes'); END IF;
    v := v || jsonb_build_object('window_minutes', n::int);
  END IF;
  IF p ? 'appointment_no' THEN
    s := app.norm_code(app.ptext(p, 'appointment_no', 60));
    IF char_length(s) > 40 THEN PERFORM app.fail('MRS_TOO_LONG', 'appointment_no'); END IF;
    v := v || jsonb_build_object('appointment_no', s);
  END IF;
  IF p ? 'driver_id' THEN v := v || jsonb_build_object('driver_id', app.puuid(p, 'driver_id')); END IF;
  IF p ? 'truck_id' THEN v := v || jsonb_build_object('truck_id', app.puuid(p, 'truck_id')); END IF;
  PERFORM app.g3_check_fleet(p_tx.org_id, NULL, (v ->> 'driver_id')::uuid, (v ->> 'truck_id')::uuid);
  IF p ? 'status' THEN
    s := app.ptext(p, 'status', 20);
    IF s IS NULL OR s NOT IN ('requested','confirmed') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    v := v || jsonb_build_object('status', s);
  END IF;
  RETURN v;
END $$;

-- create_appointment({transaction_id, container_id?, terminal_party_id?, appointment_at, window_minutes?,
--                     appointment_no?, driver_id?, truck_id?, status? requested|confirmed}, p_idem_key)
CREATE OR REPLACE FUNCTION public.create_appointment(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_replay jsonb; v_f jsonb; v_a public.port_appointments; v_txid uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','container_id','terminal_party_id','appointment_at','window_minutes',
                                         'appointment_no','driver_id','truck_id','status','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.transport_writer_roles());
  v_replay := app.idem_begin('create_appointment', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_f := app.appt_fields(p_payload - 'idempotencyKey' - 'transaction_id', v_tx);
  IF v_f ->> 'appointment_at' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'appointment_at'); END IF;
  INSERT INTO public.port_appointments (org_id, transaction_id, container_id, terminal_party_id, appointment_at, window_minutes,
                                        appointment_no, driver_id, truck_id, status, created_by)
  VALUES (v_tx.org_id, v_tx.id, (v_f ->> 'container_id')::uuid, (v_f ->> 'terminal_party_id')::uuid,
          (v_f ->> 'appointment_at')::timestamptz, (v_f ->> 'window_minutes')::int, v_f ->> 'appointment_no',
          (v_f ->> 'driver_id')::uuid, (v_f ->> 'truck_id')::uuid, coalesce(v_f ->> 'status', 'requested'), auth.uid())
  RETURNING * INTO v_a;
  PERFORM app.appt_event(v_a, 'created', NULL, NULL);
  RETURN app.idem_finish('create_appointment', p_idem_key, app.appt_json(v_a));
END $$;

-- reschedule_appointment(p_id, {appointment_at, …same fields…, status?}, p_reason, p_idem_key)
-- The old row becomes 'rescheduled' (reason kept); the new row links back via rescheduled_from_id and
-- inherits container / terminal / window / driver / truck unless the payload changes them.
CREATE OR REPLACE FUNCTION public.reschedule_appointment(p_id uuid, p_payload jsonb, p_reason text, p_idem_key uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old public.port_appointments; v_new public.port_appointments; v_tx public.transactions; v_f jsonb; v_replay jsonb;
  v_from text; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_chain jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_old FROM public.port_appointments a WHERE a.id = p_id;
  IF v_old.id IS NULL OR NOT app.has_tx_role(v_old.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_old.transaction_id, app.transport_writer_roles());
  v_replay := app.idem_begin('reschedule_appointment', p_idem_key,
    jsonb_build_object('id', p_id, 'payload', coalesce(p_payload, '{}'::jsonb) - 'idempotencyKey', 'reason', p_reason), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['container_id','terminal_party_id','appointment_at','window_minutes','appointment_no',
                                         'driver_id','truck_id','status','idempotencyKey']);
  SELECT * INTO v_old FROM public.port_appointments a WHERE a.id = p_id FOR UPDATE;
  IF v_old.status NOT IN ('requested','confirmed','missed') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_old.status); END IF;
  v_f := app.appt_fields(p_payload - 'idempotencyKey', v_tx);
  IF v_f ->> 'appointment_at' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'appointment_at'); END IF;
  v_from := v_old.status;
  UPDATE public.port_appointments a SET status = 'rescheduled', status_reason = v_reason WHERE a.id = v_old.id
  RETURNING * INTO v_old;
  INSERT INTO public.port_appointments (org_id, transaction_id, container_id, terminal_party_id, appointment_at, window_minutes,
                                        appointment_no, driver_id, truck_id, status, rescheduled_from_id, created_by)
  VALUES (v_tx.org_id, v_tx.id,
          CASE WHEN v_f ? 'container_id' THEN (v_f ->> 'container_id')::uuid ELSE v_old.container_id END,
          CASE WHEN v_f ? 'terminal_party_id' THEN (v_f ->> 'terminal_party_id')::uuid ELSE v_old.terminal_party_id END,
          (v_f ->> 'appointment_at')::timestamptz,
          CASE WHEN v_f ? 'window_minutes' THEN (v_f ->> 'window_minutes')::int ELSE v_old.window_minutes END,
          v_f ->> 'appointment_no',                       -- a new slot carries its own number (or none yet)
          CASE WHEN v_f ? 'driver_id' THEN (v_f ->> 'driver_id')::uuid ELSE v_old.driver_id END,
          CASE WHEN v_f ? 'truck_id' THEN (v_f ->> 'truck_id')::uuid ELSE v_old.truck_id END,
          coalesce(v_f ->> 'status', 'requested'), v_old.id, auth.uid())
  RETURNING * INTO v_new;
  PERFORM app.appt_event(v_old, 'rescheduled', v_from, v_reason, jsonb_build_object('replaced_by_id', v_new.id));
  PERFORM app.appt_event(v_new, 'created', NULL, NULL, jsonb_build_object('rescheduled_from_id', v_old.id));
  -- full chain, oldest first
  WITH RECURSIVE ch AS (
    SELECT a.id, a.rescheduled_from_id, 0 AS depth FROM public.port_appointments a WHERE a.id = v_new.id
    UNION ALL
    SELECT a.id, a.rescheduled_from_id, ch.depth + 1 FROM public.port_appointments a JOIN ch ON a.id = ch.rescheduled_from_id
     WHERE ch.depth < 100)
  SELECT jsonb_agg(ch.id ORDER BY ch.depth DESC) INTO v_chain FROM ch;
  RETURN app.idem_finish('reschedule_appointment', p_idem_key,
    jsonb_build_object('appointment', app.appt_json(v_new), 'rescheduled', app.appt_json(v_old), 'chain', v_chain));
END $$;

-- set_appointment_status(p_id, confirmed|completed|missed|cancelled, p_reason)
-- requested → confirmed | missed | cancelled; confirmed → completed | missed | cancelled; missed → cancelled.
-- missed / cancelled need a reason. Rescheduling goes through reschedule_appointment.
CREATE OR REPLACE FUNCTION public.set_appointment_status(p_id uuid, p_status text, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_a public.port_appointments; v_tx public.transactions; v_from text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_a FROM public.port_appointments a WHERE a.id = p_id;
  IF v_a.id IS NULL OR NOT app.has_tx_role(v_a.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_a.transaction_id, app.transport_writer_roles());
  SELECT * INTO v_a FROM public.port_appointments a WHERE a.id = p_id FOR UPDATE;
  IF p_status = 'rescheduled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'use_reschedule_appointment'); END IF;
  IF p_status IS NULL OR p_status NOT IN ('confirmed','completed','missed','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_a.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT ((v_a.status = 'requested' AND p_status IN ('confirmed','missed','cancelled'))
       OR (v_a.status = 'confirmed' AND p_status IN ('completed','missed','cancelled'))
       OR (v_a.status = 'missed' AND p_status = 'cancelled')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', v_a.status);
  END IF;
  IF p_status IN ('missed','cancelled') AND v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  v_from := v_a.status;
  UPDATE public.port_appointments a
     SET status = p_status, status_reason = CASE WHEN v_reason IS NOT NULL THEN v_reason ELSE a.status_reason END
   WHERE a.id = v_a.id RETURNING * INTO v_a;
  PERFORM app.appt_event(v_a, 'status', v_from, v_reason);
  RETURN app.appt_json(v_a) || jsonb_build_object('from', v_from);
END $$;

-- ---------------------------------------------------------------------
-- 6. transport trips (G3.12)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transport_trips (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  transaction_id uuid NOT NULL,
  container_id   uuid,
  leg_no         int NOT NULL DEFAULT 1 CHECK (leg_no BETWEEN 1 AND 50),
  carrier_id     uuid,                                   -- NULL = own fleet / not assigned yet
  driver_id      uuid,
  truck_id       uuid,
  origin         text CHECK (char_length(origin) <= 120),
  destination    text CHECK (char_length(destination) <= 120),
  planned_at     timestamptz,
  loaded_at      timestamptz,
  unloaded_at    timestamptz,
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','dispatched','loaded','delivered','cancelled')),
  status_reason  text CHECK (char_length(status_reason) <= 500),
  -- cost / sell: NOT in the API SELECT grant (trip_finance). No payment fields here (G4).
  cost_amount    numeric(12,2) CHECK (cost_amount >= 0),
  cost_currency  text NOT NULL DEFAULT 'SAR' CHECK (cost_currency ~ '^[A-Z]{3}$'),
  sell_amount    numeric(12,2) CHECK (sell_amount >= 0),
  sell_currency  text NOT NULL DEFAULT 'SAR' CHECK (sell_currency ~ '^[A-Z]{3}$'),
  cost_basis     text CHECK (cost_basis IN ('agreed','estimated','invoice')),
  notes          text CHECK (char_length(notes) <= 2000),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_trips_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT transport_trips_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT transport_trips_carrier_fk FOREIGN KEY (carrier_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT transport_trips_driver_fk FOREIGN KEY (driver_id, org_id) REFERENCES public.drivers(id, org_id),
  CONSTRAINT transport_trips_truck_fk FOREIGN KEY (truck_id, org_id) REFERENCES public.trucks(id, org_id),
  CONSTRAINT transport_trips_times_chk CHECK (unloaded_at IS NULL OR loaded_at IS NULL OR unloaded_at >= loaded_at),
  CONSTRAINT transport_trips_cancel_chk CHECK (status <> 'cancelled' OR status_reason IS NOT NULL),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.transport_trips IS 'G3.12 transport legs per transaction / container. Cost & sell are internal (trip_finance); carrier payment and client pricing are G4.';
CREATE INDEX IF NOT EXISTS transport_trips_tx_idx ON public.transport_trips (transaction_id, leg_no);
CREATE INDEX IF NOT EXISTS transport_trips_planned_idx ON public.transport_trips (org_id, planned_at) WHERE status IN ('planned','dispatched','loaded');

CREATE OR REPLACE FUNCTION app.trip_finance_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['cost_amount','cost_currency','sell_amount','sell_currency','cost_basis']
$$;

-- trip without the finance columns (what every writer may see)
CREATE OR REPLACE FUNCTION app.trip_json(t public.transport_trips) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', t.id, 'org_id', t.org_id, 'transaction_id', t.transaction_id, 'container_id', t.container_id,
    'leg_no', t.leg_no, 'carrier_id', t.carrier_id, 'driver_id', t.driver_id, 'truck_id', t.truck_id, 'origin', t.origin,
    'destination', t.destination, 'planned_at', t.planned_at, 'loaded_at', t.loaded_at, 'unloaded_at', t.unloaded_at,
    'status', t.status, 'status_reason', t.status_reason, 'notes', t.notes, 'created_by', t.created_by,
    'created_at', t.created_at, 'updated_at', t.updated_at)
$$;

CREATE OR REPLACE FUNCTION app.trip_event(t public.transport_trips, p_op text, p_from text, p_note text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- internal; never carries amounts
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor, payload)
  VALUES (t.org_id, t.transaction_id, 'trip', p_from, t.status, left(p_note, 2000), false, auth.uid(),
          jsonb_build_object('op', p_op, 'trip_id', t.id, 'leg_no', t.leg_no, 'container_id', t.container_id)
          || coalesce(p_extra, '{}'::jsonb));
END $$;

-- payload → normalized trip fields (keys present only)
CREATE OR REPLACE FUNCTION app.trip_fields(p jsonb, p_tx public.transactions) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; n numeric; s text; k text;
BEGIN
  IF p ? 'container_id' THEN
    v := v || jsonb_build_object('container_id', app.puuid(p, 'container_id'));
    PERFORM app.g3_check_container(p_tx.id, (v ->> 'container_id')::uuid);
  END IF;
  IF p ? 'leg_no' THEN
    n := app.pnum(p, 'leg_no', 50);
    IF n IS NULL OR n < 1 OR n <> trunc(n) THEN PERFORM app.fail('MRS_INVALID', 'leg_no'); END IF;
    v := v || jsonb_build_object('leg_no', n::int);
  END IF;
  IF p ? 'carrier_id' THEN
    v := v || jsonb_build_object('carrier_id', app.puuid(p, 'carrier_id'));
    PERFORM app.g3_check_party(p_tx.org_id, (v ->> 'carrier_id')::uuid, ARRAY['carrier'], 'carrier_id');
  END IF;
  IF p ? 'driver_id' THEN v := v || jsonb_build_object('driver_id', app.puuid(p, 'driver_id')); END IF;
  IF p ? 'truck_id' THEN v := v || jsonb_build_object('truck_id', app.puuid(p, 'truck_id')); END IF;
  IF p ? 'origin' THEN v := v || jsonb_build_object('origin', app.ptext(p, 'origin', 120)); END IF;
  IF p ? 'destination' THEN v := v || jsonb_build_object('destination', app.ptext(p, 'destination', 120)); END IF;
  IF p ? 'planned_at' THEN v := v || jsonb_build_object('planned_at', app.pts(p, 'planned_at')); END IF;
  IF p ? 'notes' THEN v := v || jsonb_build_object('notes', app.ptext(p, 'notes', 2000)); END IF;
  IF p ? 'cost_amount' THEN v := v || jsonb_build_object('cost_amount', round(app.pnum(p, 'cost_amount', 9999999999.99), 2)); END IF;
  IF p ? 'sell_amount' THEN v := v || jsonb_build_object('sell_amount', round(app.pnum(p, 'sell_amount', 9999999999.99), 2)); END IF;
  FOREACH k IN ARRAY ARRAY['cost_currency','sell_currency'] LOOP
    IF p ? k THEN
      s := upper(coalesce(app.ptext(p, k, 3), 'SAR'));
      IF s !~ '^[A-Z]{3}$' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
      v := v || jsonb_build_object(k, s);
    END IF;
  END LOOP;
  IF p ? 'cost_basis' THEN
    s := app.ptext(p, 'cost_basis', 20);
    IF s IS NOT NULL AND s NOT IN ('agreed','estimated','invoice') THEN PERFORM app.fail('MRS_INVALID', 'cost_basis'); END IF;
    v := v || jsonb_build_object('cost_basis', s);
  END IF;
  RETURN v;
END $$;

-- create_trip({transaction_id, container_id?, leg_no? (default: next leg of the transaction / container),
--              carrier_id?, driver_id?, truck_id?, origin?, destination?, planned_at?, notes?,
--              cost_amount?, cost_currency?, sell_amount?, sell_currency?, cost_basis?}, p_idem_key)
-- Transport writers create; the cost / sell keys need a trip-finance role (MRS_FORBIDDEN 'cost').
CREATE OR REPLACE FUNCTION public.create_trip(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_replay jsonb; v_f jsonb; v_t public.transport_trips; v_txid uuid; v_leg int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','container_id','leg_no','carrier_id','driver_id','truck_id','origin',
    'destination','planned_at','notes','cost_amount','cost_currency','sell_amount','sell_currency','cost_basis','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.transport_writer_roles());
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k = ANY (app.trip_finance_keys()))
     AND NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.trip_finance_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'cost');
  END IF;
  v_replay := app.idem_begin('create_trip', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_f := app.trip_fields(p_payload - 'idempotencyKey' - 'transaction_id', v_tx);
  PERFORM app.g3_check_fleet(v_tx.org_id, (v_f ->> 'carrier_id')::uuid, (v_f ->> 'driver_id')::uuid, (v_f ->> 'truck_id')::uuid);
  v_leg := coalesce((v_f ->> 'leg_no')::int, (SELECT coalesce(max(t.leg_no), 0) + 1 FROM public.transport_trips t
                     WHERE t.transaction_id = v_tx.id AND t.container_id IS NOT DISTINCT FROM (v_f ->> 'container_id')::uuid));
  INSERT INTO public.transport_trips (org_id, transaction_id, container_id, leg_no, carrier_id, driver_id, truck_id, origin,
    destination, planned_at, notes, cost_amount, cost_currency, sell_amount, sell_currency, cost_basis, created_by)
  VALUES (v_tx.org_id, v_tx.id, (v_f ->> 'container_id')::uuid, least(v_leg, 50), (v_f ->> 'carrier_id')::uuid,
    (v_f ->> 'driver_id')::uuid, (v_f ->> 'truck_id')::uuid, v_f ->> 'origin', v_f ->> 'destination',
    (v_f ->> 'planned_at')::timestamptz, v_f ->> 'notes', (v_f ->> 'cost_amount')::numeric, coalesce(v_f ->> 'cost_currency', 'SAR'),
    (v_f ->> 'sell_amount')::numeric, coalesce(v_f ->> 'sell_currency', 'SAR'), v_f ->> 'cost_basis', auth.uid())
  RETURNING * INTO v_t;
  PERFORM app.trip_event(v_t, 'created', NULL, NULL);
  RETURN app.idem_finish('create_trip', p_idem_key, app.trip_json(v_t));
END $$;

-- update_trip(p_id, {any create_trip field except transaction_id}) — partial. Operational keys need a
-- transport writer (not on a cancelled trip); cost / sell keys need a trip-finance role (any status).
CREATE OR REPLACE FUNCTION public.update_trip(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_t public.transport_trips; v_new public.transport_trips; v_tx public.transactions; v_f jsonb;
  v_fin boolean; v_ops boolean; v_changed jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_t FROM public.transport_trips t WHERE t.id = p_id;
  IF v_t.id IS NULL OR NOT app.has_tx_role(v_t.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['container_id','leg_no','carrier_id','driver_id','truck_id','origin','destination',
    'planned_at','notes','cost_amount','cost_currency','sell_amount','sell_currency','cost_basis']);
  v_fin := EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k = ANY (app.trip_finance_keys()));
  v_ops := EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT (k = ANY (app.trip_finance_keys())));
  IF NOT v_fin AND NOT v_ops THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  v_tx := app.g3_lock_tx(v_t.transaction_id, app.staff_roles());
  IF v_ops AND NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.transport_writer_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  IF v_fin AND NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.trip_finance_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'cost');
  END IF;
  SELECT * INTO v_t FROM public.transport_trips t WHERE t.id = p_id FOR UPDATE;
  IF v_ops AND v_t.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  v_f := app.trip_fields(p_payload, v_tx);
  PERFORM app.g3_check_fleet(v_tx.org_id,
    CASE WHEN v_f ? 'carrier_id' THEN (v_f ->> 'carrier_id')::uuid ELSE v_t.carrier_id END,
    CASE WHEN v_f ? 'driver_id' THEN (v_f ->> 'driver_id')::uuid ELSE v_t.driver_id END,
    CASE WHEN v_f ? 'truck_id' THEN (v_f ->> 'truck_id')::uuid ELSE v_t.truck_id END);
  UPDATE public.transport_trips t SET
    container_id  = CASE WHEN v_f ? 'container_id' THEN (v_f ->> 'container_id')::uuid ELSE t.container_id END,
    leg_no        = CASE WHEN v_f ? 'leg_no' THEN (v_f ->> 'leg_no')::int ELSE t.leg_no END,
    carrier_id    = CASE WHEN v_f ? 'carrier_id' THEN (v_f ->> 'carrier_id')::uuid ELSE t.carrier_id END,
    driver_id     = CASE WHEN v_f ? 'driver_id' THEN (v_f ->> 'driver_id')::uuid ELSE t.driver_id END,
    truck_id      = CASE WHEN v_f ? 'truck_id' THEN (v_f ->> 'truck_id')::uuid ELSE t.truck_id END,
    origin        = CASE WHEN v_f ? 'origin' THEN v_f ->> 'origin' ELSE t.origin END,
    destination   = CASE WHEN v_f ? 'destination' THEN v_f ->> 'destination' ELSE t.destination END,
    planned_at    = CASE WHEN v_f ? 'planned_at' THEN (v_f ->> 'planned_at')::timestamptz ELSE t.planned_at END,
    notes         = CASE WHEN v_f ? 'notes' THEN v_f ->> 'notes' ELSE t.notes END,
    cost_amount   = CASE WHEN v_f ? 'cost_amount' THEN (v_f ->> 'cost_amount')::numeric ELSE t.cost_amount END,
    cost_currency = CASE WHEN v_f ? 'cost_currency' THEN v_f ->> 'cost_currency' ELSE t.cost_currency END,
    sell_amount   = CASE WHEN v_f ? 'sell_amount' THEN (v_f ->> 'sell_amount')::numeric ELSE t.sell_amount END,
    sell_currency = CASE WHEN v_f ? 'sell_currency' THEN v_f ->> 'sell_currency' ELSE t.sell_currency END,
    cost_basis    = CASE WHEN v_f ? 'cost_basis' THEN v_f ->> 'cost_basis' ELSE t.cost_basis END
   WHERE t.id = v_t.id RETURNING * INTO v_new;
  -- names of the changed fields only (the event never carries amounts)
  SELECT jsonb_agg(k ORDER BY k) INTO v_changed FROM jsonb_object_keys(v_f) k
   WHERE (to_jsonb(v_new) -> k) IS DISTINCT FROM (to_jsonb(v_t) -> k);
  IF v_changed IS NOT NULL THEN
    PERFORM app.trip_event(v_new, 'updated', v_new.status, NULL, jsonb_build_object('changed', v_changed));
  END IF;
  RETURN app.trip_json(v_new) || jsonb_build_object('changed', coalesce(v_changed, '[]'::jsonb));
END $$;

-- set_trip_status(p_id, dispatched|loaded|delivered|cancelled, p_at, p_note)
-- Forward only (planned → dispatched → loaded → delivered; skipping ahead allowed); cancelled from any
-- open status with a note. loaded stamps loaded_at, delivered stamps unloaded_at (p_at, default now()).
CREATE OR REPLACE FUNCTION public.set_trip_status(p_id uuid, p_status text, p_at timestamptz DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_t public.transport_trips; v_tx public.transactions; v_from text; v_at timestamptz := coalesce(p_at, now());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_order text[] := ARRAY['planned','dispatched','loaded','delivered'];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_t FROM public.transport_trips t WHERE t.id = p_id;
  IF v_t.id IS NULL OR NOT app.has_tx_role(v_t.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_t.transaction_id, app.transport_writer_roles());
  SELECT * INTO v_t FROM public.transport_trips t WHERE t.id = p_id FOR UPDATE;
  IF p_status IS NULL OR p_status NOT IN ('dispatched','loaded','delivered','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_t.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF v_t.status IN ('delivered','cancelled') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_t.status); END IF;
  IF p_status <> 'cancelled' AND array_position(v_order, p_status) < array_position(v_order, v_t.status) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'backward');
  END IF;
  IF p_status = 'cancelled' AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v_note) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF v_at > now() + interval '1 day' THEN PERFORM app.fail('MRS_INVALID', 'at'); END IF;
  IF p_status = 'delivered' AND v_t.loaded_at IS NOT NULL AND v_at < v_t.loaded_at THEN PERFORM app.fail('MRS_INVALID', 'at'); END IF;
  v_from := v_t.status;
  UPDATE public.transport_trips t SET
    status        = p_status,
    loaded_at     = CASE WHEN p_status = 'loaded' THEN v_at ELSE t.loaded_at END,
    unloaded_at   = CASE WHEN p_status = 'delivered' THEN v_at ELSE t.unloaded_at END,
    status_reason = CASE WHEN p_status = 'cancelled' THEN v_note ELSE t.status_reason END
   WHERE t.id = v_t.id RETURNING * INTO v_t;
  PERFORM app.trip_event(v_t, 'status', v_from, v_note, jsonb_build_object('at', v_at));
  RETURN app.trip_json(v_t) || jsonb_build_object('from', v_from);
END $$;

-- trip_finance(p_ids) — {trip_id: {cost_amount, cost_currency, sell_amount, sell_currency, cost_basis}} for the
-- trips the caller may see AND whose branch grants a trip-finance role. Others are silently left out.
CREATE OR REPLACE FUNCTION public.trip_finance(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_ids) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  RETURN coalesce((
    SELECT jsonb_object_agg(t.id::text, jsonb_build_object('cost_amount', t.cost_amount, 'cost_currency', t.cost_currency,
             'sell_amount', t.sell_amount, 'sell_currency', t.sell_currency, 'cost_basis', t.cost_basis))
      FROM public.transport_trips t JOIN public.transactions x ON x.id = t.transaction_id
     WHERE t.id = ANY (p_ids) AND app.has_branch_role(x.org_id, x.branch_id, app.trip_finance_roles())), '{}'::jsonb);
END $$;

-- ---------------------------------------------------------------------
-- 7. empty return additions (G3.13)
-- ---------------------------------------------------------------------
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS return_yard_party_id uuid;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS return_instruction_document_id uuid;   -- Return Note: instruction, NOT proof
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS evidence_received_at timestamptz;
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_return_yard_fk;
ALTER TABLE public.containers ADD CONSTRAINT containers_return_yard_fk
  FOREIGN KEY (return_yard_party_id, org_id) REFERENCES public.parties(id, org_id);
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_return_instruction_fk;
ALTER TABLE public.containers ADD CONSTRAINT containers_return_instruction_fk
  FOREIGN KEY (return_instruction_document_id, org_id) REFERENCES public.documents(id, org_id);

-- yard must be a yard / terminal of the org, the instruction a document of this transaction;
-- evidence_received_at is stamped when a (new) evidence document is attached.
CREATE OR REPLACE FUNCTION app.tg_containers_g3b_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.return_yard_party_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.return_yard_party_id IS DISTINCT FROM OLD.return_yard_party_id) THEN
    PERFORM app.g3_check_party(NEW.org_id, NEW.return_yard_party_id, ARRAY['yard','terminal_operator'], 'return_yard_party_id');
  END IF;
  IF NEW.return_instruction_document_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.return_instruction_document_id IS DISTINCT FROM OLD.return_instruction_document_id) THEN
    PERFORM app.g3_check_document(NEW.transaction_id, NEW.return_instruction_document_id, 'return_instruction_document_id');
  END IF;
  -- (legacy rows with evidence keep NULL = receipt time unknown)
  IF NEW.evidence_document_id IS NULL THEN
    NEW.evidence_received_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.evidence_received_at := coalesce(NEW.evidence_received_at, now());
  ELSIF NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id
        AND NEW.evidence_received_at IS NOT DISTINCT FROM OLD.evidence_received_at THEN
    NEW.evidence_received_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g3b_before ON public.containers;
CREATE TRIGGER trg_g3b_before BEFORE INSERT OR UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION app.tg_containers_g3b_before();

-- set_container_return(p_container, {return_deadline?, return_yard_party_id?, return_location?,
--                                    return_instruction_document_id?}) — the return PLAN. Proof stays on the
-- existing path (evidence_document_id + return_status = returned_verified, confirmed receipt only).
CREATE OR REPLACE FUNCTION public.set_container_return(p_container uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.containers; v_new public.containers; v_tx public.transactions; v_yard uuid; v_doc uuid; v_loc text;
  v_changed jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.containers c WHERE c.id = p_container;
  IF v_c.id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_c.transaction_id, app.transport_writer_roles());
  PERFORM app.only_keys(p_payload, ARRAY['return_deadline','return_yard_party_id','return_location','return_instruction_document_id']);
  IF p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  SELECT * INTO v_c FROM public.containers c WHERE c.id = p_container FOR UPDATE;
  IF v_c.return_status IN ('returned_verified','waived') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.return_status); END IF;
  v_yard := app.puuid(p_payload, 'return_yard_party_id');
  v_doc := app.puuid(p_payload, 'return_instruction_document_id');
  v_loc := app.ptext(p_payload, 'return_location', 120);
  IF p_payload ? 'return_yard_party_id' THEN
    PERFORM app.g3_check_party(v_tx.org_id, v_yard, ARRAY['yard','terminal_operator'], 'return_yard_party_id');
    -- a chosen yard fills an empty location with its name
    IF v_yard IS NOT NULL AND NOT (p_payload ? 'return_location') AND v_c.return_location IS NULL THEN
      SELECT left(pa.name_ar, 120) INTO v_loc FROM public.parties pa WHERE pa.id = v_yard;
    END IF;
  END IF;
  IF p_payload ? 'return_instruction_document_id' THEN
    PERFORM app.g3_check_document(v_tx.id, v_doc, 'return_instruction_document_id');
  END IF;
  UPDATE public.containers c SET
    return_deadline = CASE WHEN p_payload ? 'return_deadline' THEN app.pdate(p_payload, 'return_deadline') ELSE c.return_deadline END,
    return_yard_party_id = CASE WHEN p_payload ? 'return_yard_party_id' THEN v_yard ELSE c.return_yard_party_id END,
    return_location = CASE WHEN p_payload ? 'return_location' OR v_loc IS NOT NULL THEN v_loc ELSE c.return_location END,
    return_instruction_document_id = CASE WHEN p_payload ? 'return_instruction_document_id' THEN v_doc
                                          ELSE c.return_instruction_document_id END
   WHERE c.id = v_c.id RETURNING * INTO v_new;
  SELECT jsonb_agg(k ORDER BY k) INTO v_changed
    FROM unnest(ARRAY['return_deadline','return_yard_party_id','return_location','return_instruction_document_id']) k
   WHERE (to_jsonb(v_new) -> k) IS DISTINCT FROM (to_jsonb(v_c) -> k);
  IF v_changed IS NOT NULL THEN
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
    VALUES (v_new.org_id, v_new.transaction_id, 'container', v_new.operational_state, v_new.operational_state, false, auth.uid(),
            jsonb_build_object('op', 'return_plan', 'container_id', v_new.id, 'container_no', v_new.container_no,
                               'changed', v_changed, 'return_deadline', v_new.return_deadline));
  END IF;
  RETURN jsonb_build_object('id', v_new.id, 'transaction_id', v_new.transaction_id, 'container_no', v_new.container_no,
    'return_deadline', v_new.return_deadline, 'return_yard_party_id', v_new.return_yard_party_id,
    'return_location', v_new.return_location, 'return_instruction_document_id', v_new.return_instruction_document_id,
    'return_status', v_new.return_status, 'evidence_document_id', v_new.evidence_document_id,
    'evidence_received_at', v_new.evidence_received_at, 'operational_state', v_new.operational_state,
    'changed', coalesce(v_changed, '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------
-- 8. operational exceptions (G3.14)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.operational_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  transaction_id  uuid NOT NULL,
  container_id    uuid,
  declaration_id  uuid,                                  -- set for declaration_cancelled (system)
  kind            text NOT NULL CHECK (kind IN ('declaration_cancelled','demurrage','detention_extension','customs_rejection',
                    'inspection','repair_fee','cleaning_fee','appointment_change','transport_change','other')),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','document','email','system')),
  document_id     uuid,
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  amount          numeric(12,2) CHECK (amount >= 0),
  currency        text NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','waived')),
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution_note text CHECK (char_length(resolution_note) <= 2000),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_exceptions_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT operational_exceptions_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT operational_exceptions_doc_fk FOREIGN KEY (document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT operational_exceptions_decl_fk FOREIGN KEY (declaration_id, org_id) REFERENCES public.customs_declarations(id, org_id),
  -- fees are never just a claim: a document or an amount
  CONSTRAINT operational_exceptions_fee_chk CHECK (kind NOT IN ('demurrage','repair_fee','cleaning_fee')
                                                   OR document_id IS NOT NULL OR amount IS NOT NULL),
  CONSTRAINT operational_exceptions_resolved_chk CHECK ((status IN ('resolved','waived')) = (resolved_at IS NOT NULL)
                                                        AND (status NOT IN ('resolved','waived') OR resolution_note IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.operational_exceptions IS 'G3.14 operational exceptions (demurrage, rejections, fees, changes…). Source + date + reason always; staff-only.';
CREATE INDEX IF NOT EXISTS operational_exceptions_tx_idx ON public.operational_exceptions (transaction_id, occurred_at);
CREATE INDEX IF NOT EXISTS operational_exceptions_open_idx ON public.operational_exceptions (org_id, status) WHERE status IN ('open','in_progress');

CREATE OR REPLACE FUNCTION app.exc_json(e public.operational_exceptions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', e.id, 'org_id', e.org_id, 'transaction_id', e.transaction_id, 'container_id', e.container_id,
    'declaration_id', e.declaration_id, 'kind', e.kind, 'occurred_at', e.occurred_at, 'source', e.source,
    'document_id', e.document_id, 'reason', e.reason, 'amount', e.amount, 'currency', e.currency, 'status', e.status,
    'resolved_at', e.resolved_at, 'resolved_by', e.resolved_by, 'resolution_note', e.resolution_note,
    'created_by', e.created_by, 'created_at', e.created_at, 'updated_at', e.updated_at)
$$;

CREATE OR REPLACE FUNCTION app.exc_event(e public.operational_exceptions, p_op text, p_from text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor, payload)
  VALUES (e.org_id, e.transaction_id, 'exception', p_from, e.status, left(p_note, 2000), false, auth.uid(),
          jsonb_build_object('op', p_op, 'exception_id', e.id, 'kind', e.kind, 'source', e.source, 'container_id', e.container_id));
END $$;

-- shared insert (create_exception, cancel_declaration)
CREATE OR REPLACE FUNCTION app.exc_insert(p_tx public.transactions, p_kind text, p_source text, p_reason text,
  p_container uuid, p_document uuid, p_declaration uuid, p_amount numeric, p_currency text, p_occurred timestamptz)
RETURNS public.operational_exceptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_e public.operational_exceptions;
BEGIN
  INSERT INTO public.operational_exceptions (org_id, transaction_id, container_id, declaration_id, kind, occurred_at, source,
                                             document_id, reason, amount, currency, created_by)
  VALUES (p_tx.org_id, p_tx.id, p_container, p_declaration, p_kind, coalesce(p_occurred, now()), p_source, p_document,
          left(p_reason, 2000), p_amount, coalesce(p_currency, 'SAR'), auth.uid())
  RETURNING * INTO v_e;
  PERFORM app.exc_event(v_e, 'created', NULL, NULL);
  RETURN v_e;
END $$;

-- create_exception({transaction_id, kind, reason, container_id?, occurred_at?, source? manual|document|email,
--                   document_id?, amount?, currency?}, p_idem_key). 'system' is reserved for the server.
CREATE OR REPLACE FUNCTION public.create_exception(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions; v_replay jsonb; v_e public.operational_exceptions; v_txid uuid;
  v_kind text; v_source text; v_reason text; v_ct uuid; v_doc uuid; v_amount numeric; v_cur text; v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','container_id','kind','occurred_at','source','document_id','reason',
                                         'amount','currency','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.transport_writer_roles());
  v_replay := app.idem_begin('create_exception', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_kind := app.ptext(p_payload, 'kind', 30, true);
  IF v_kind NOT IN ('demurrage','detention_extension','customs_rejection','inspection','repair_fee','cleaning_fee',
                    'appointment_change','transport_change','other','declaration_cancelled') THEN
    PERFORM app.fail('MRS_INVALID', 'kind');
  END IF;
  v_source := coalesce(app.ptext(p_payload, 'source', 20), 'manual');
  IF v_source NOT IN ('manual','document','email') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
  v_reason := app.ptext(p_payload, 'reason', 2000);
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  v_ct := app.puuid(p_payload, 'container_id');
  PERFORM app.g3_check_container(v_tx.id, v_ct);
  v_doc := app.puuid(p_payload, 'document_id');
  PERFORM app.g3_check_document(v_tx.id, v_doc, 'document_id');
  IF v_source = 'document' AND v_doc IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'document_id'); END IF;
  v_amount := round(app.pnum(p_payload, 'amount', 9999999999.99), 2);
  v_cur := upper(app.ptext(p_payload, 'currency', 3));
  IF v_cur IS NOT NULL AND v_cur !~ '^[A-Z]{3}$' THEN PERFORM app.fail('MRS_INVALID', 'currency'); END IF;
  IF v_kind IN ('demurrage','repair_fee','cleaning_fee') AND v_doc IS NULL AND v_amount IS NULL THEN
    PERFORM app.fail('MRS_REQUIRED', 'document_or_amount');
  END IF;
  v_at := coalesce(app.pts(p_payload, 'occurred_at'), now());
  IF v_at > now() + interval '1 day' THEN PERFORM app.fail('MRS_INVALID', 'occurred_at'); END IF;
  v_e := app.exc_insert(v_tx, v_kind, v_source, v_reason, v_ct, v_doc, NULL, v_amount, v_cur, v_at);
  RETURN app.idem_finish('create_exception', p_idem_key, app.exc_json(v_e));
END $$;

-- resolve_exception(p_id, in_progress|resolved|waived, p_note)
-- open → in_progress | resolved | waived; in_progress → resolved | waived. resolved / waived need a note;
-- waived needs a senior role.
CREATE OR REPLACE FUNCTION public.resolve_exception(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_e public.operational_exceptions; v_tx public.transactions; v_from text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_e FROM public.operational_exceptions e WHERE e.id = p_id;
  IF v_e.id IS NULL OR NOT app.has_tx_role(v_e.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_e.transaction_id, app.transport_writer_roles());
  SELECT * INTO v_e FROM public.operational_exceptions e WHERE e.id = p_id FOR UPDATE;
  IF p_status IS NULL OR p_status NOT IN ('in_progress','resolved','waived') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_e.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF v_e.status IN ('resolved','waived') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_e.status); END IF;
  IF p_status IN ('resolved','waived') AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF p_status = 'waived' AND NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.senior_ops_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'waiver');
  END IF;
  v_from := v_e.status;
  UPDATE public.operational_exceptions e SET
    status = p_status,
    resolved_at = CASE WHEN p_status IN ('resolved','waived') THEN now() END,
    resolved_by = CASE WHEN p_status IN ('resolved','waived') THEN auth.uid() END,
    resolution_note = CASE WHEN p_status IN ('resolved','waived') THEN v_note END
   WHERE e.id = v_e.id RETURNING * INTO v_e;
  PERFORM app.exc_event(v_e, 'status', v_from, v_note);
  RETURN app.exc_json(v_e) || jsonb_build_object('from', v_from);
END $$;

-- cancel_declaration — body = migration A; + an automatic declaration_cancelled exception (source system)
CREATE OR REPLACE FUNCTION public.cancel_declaration(p_id uuid, p_reason text, p_replacement jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.customs_declarations; v_new public.customs_declarations; v_tx public.transactions; v_from text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_exc public.operational_exceptions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_d FROM public.customs_declarations d WHERE d.id = p_id;
  IF v_d.id IS NULL OR NOT app.has_tx_role(v_d.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_d.transaction_id, app.ops_writer_roles());
  SELECT * INTO v_d FROM public.customs_declarations d WHERE d.id = p_id FOR UPDATE;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  IF v_d.status IN ('cancelled','replaced') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  IF p_replacement IS NOT NULL AND jsonb_typeof(p_replacement) NOT IN ('object','null') THEN
    PERFORM app.fail('MRS_INVALID', 'replacement');
  END IF;
  v_from := v_d.status;
  UPDATE public.customs_declarations d SET status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
   WHERE d.id = v_d.id RETURNING * INTO v_d;
  PERFORM app.decl_event(v_d, 'cancelled', v_from, v_reason);
  -- G3.14: every cancellation is an operational exception to follow up
  v_exc := app.exc_insert(v_tx, 'declaration_cancelled', 'system', v_reason, NULL, NULL, v_d.id, NULL, NULL, now());
  IF p_replacement IS NOT NULL AND jsonb_typeof(p_replacement) = 'object' THEN
    v_new := app.decl_insert(v_tx, p_replacement - 'idempotencyKey', true);
    UPDATE public.customs_declarations d SET status = 'replaced', replaced_by_id = v_new.id WHERE d.id = v_d.id
    RETURNING * INTO v_d;
    PERFORM app.decl_event(v_d, 'replaced', 'cancelled', NULL, jsonb_build_object('replaced_by_id', v_new.id));
  END IF;
  RETURN jsonb_build_object('cancelled', app.decl_json(v_d),
                            'replacement', CASE WHEN v_new.id IS NOT NULL THEN app.decl_json(v_new) END,
                            'exception_id', v_exc.id);
END $$;

-- ---------------------------------------------------------------------
-- 9. transaction_completeness — body = migration A; document items now come from
--    document_requirements when the org has rules (A's fixed list otherwise).
--    ready_for never lists a stage after customs_declaration before a declaration is released.
--    Optional requirements are listed (optional:true) but never lower the score.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transaction_completeness(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions;
  v_items jsonb := '[]'::jsonb;
  v_docs text[]; v_kind text; v_st text; v_configured boolean;
  v_n_ct int; v_open int; v_cur int; v_ready jsonb := '[]'::jsonb; v_total int; v_ok int; s record; r record;
  v_released boolean; v_limit text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;

  -- data items: [field, ok, label_ar, label_en, required_for]
  IF v_tx.mode IN ('sea','air') THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('field', 'bl_number', 'required_for', 'customs_declaration',
      'ok', EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id),
      'label_ar', 'بوليصة الشحن مرتبطة بالمعاملة', 'label_en', 'Bill of lading linked'));
  END IF;
  v_items := v_items || jsonb_build_array(
    jsonb_build_object('field', 'goods_description', 'required_for', 'customs_declaration', 'ok', v_tx.goods_description IS NOT NULL,
      'label_ar', 'وصف البضاعة', 'label_en', 'Goods description'),
    jsonb_build_object('field', CASE WHEN v_tx.operation = 'import' THEN 'port_of_discharge' ELSE 'port_of_loading' END,
      'required_for', 'customs_declaration',
      'ok', CASE WHEN v_tx.operation = 'import' THEN v_tx.port_of_discharge IS NOT NULL ELSE v_tx.port_of_loading IS NOT NULL END,
      'label_ar', CASE WHEN v_tx.operation = 'import' THEN 'منفذ الوصول' ELSE 'منفذ الشحن' END,
      'label_en', CASE WHEN v_tx.operation = 'import' THEN 'Port of discharge' ELSE 'Port of loading' END),
    jsonb_build_object('field', 'country', 'required_for', 'customs_declaration', 'ok', v_tx.country IS NOT NULL,
      'label_ar', CASE WHEN v_tx.operation = 'import' THEN 'بلد المنشأ' ELSE 'بلد الوجهة' END,
      'label_en', CASE WHEN v_tx.operation = 'import' THEN 'Country of origin' ELSE 'Destination country' END),
    jsonb_build_object('field', 'hs_code', 'required_for', 'customs_declaration', 'ok', v_tx.hs_code IS NOT NULL,
      'label_ar', 'رمز النظام المنسق (HS)', 'label_en', 'HS code'),
    jsonb_build_object('field', 'declaration', 'required_for', 'appointment',
      'ok', EXISTS (SELECT 1 FROM public.customs_declarations d
                     WHERE d.transaction_id = v_tx.id AND d.status NOT IN ('cancelled','replaced')),
      'label_ar', 'بيان جمركي نشط', 'label_en', 'Active customs declaration'));

  SELECT count(*) INTO v_n_ct FROM public.containers c WHERE c.transaction_id = v_tx.id;
  IF coalesce(v_tx.container_count, 0) > 0 OR v_n_ct > 0 THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('field', 'containers', 'required_for', 'transport',
      'ok', v_n_ct >= coalesce(v_tx.container_count, 0) AND v_n_ct > 0,
      'label_ar', 'تسجيل كل الحاويات', 'label_en', 'All containers registered'));
    SELECT count(*) INTO v_open FROM public.containers c
     WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived');
    v_items := v_items || jsonb_build_array(jsonb_build_object('field', 'empty_return', 'required_for', 'operationally_complete',
      'ok', v_open = 0 AND v_n_ct >= coalesce(v_tx.container_count, 0),
      'label_ar', 'إثبات إرجاع كل حاوية فارغة', 'label_en', 'Empty return proven for every container'));
  END IF;

  -- document items: confirmed / reclassified to the kind and not voided = satisfied
  v_configured := EXISTS (SELECT 1 FROM public.document_requirements q WHERE q.org_id = v_tx.org_id);
  IF v_configured THEN
    FOR r IN SELECT * FROM app.tx_requirements(v_tx.id) x WHERE x.status <> 'not_applicable' LOOP
      v_items := v_items || jsonb_build_array(jsonb_build_object('document', r.document_kind, 'required_for', r.required_for_stage,
        'ok', r.status = 'satisfied', 'status', r.status, 'optional', r.is_optional,
        'label_ar', r.label_ar, 'label_en', r.label_en));
    END LOOP;
  ELSE
    v_docs := CASE WHEN v_tx.mode = 'land' THEN ARRAY['commercial_invoice','packing_list']
                   ELSE ARRAY['bill_of_lading','commercial_invoice','packing_list'] END;
    FOREACH v_kind IN ARRAY v_docs LOOP
      v_st := CASE
        WHEN EXISTS (SELECT 1 FROM public.documents d WHERE d.transaction_id = v_tx.id AND d.voided_at IS NULL
                       AND d.classification = v_kind AND d.classification_status IN ('confirmed','reclassified')) THEN 'satisfied'
        WHEN EXISTS (SELECT 1 FROM public.documents d WHERE d.transaction_id = v_tx.id AND d.voided_at IS NULL
                       AND (d.kind = v_kind OR d.classification = v_kind)) THEN 'unreviewed'
        ELSE 'missing' END;
      v_items := v_items || jsonb_build_array((SELECT jsonb_build_object('document', v_kind, 'required_for', 'customs_declaration',
        'ok', v_st = 'satisfied', 'status', v_st, 'optional', false,
        'label_ar', coalesce(l.label_ar, v_kind), 'label_en', coalesce(l.label_en, v_kind))
        FROM (SELECT 1) one LEFT JOIN public.status_labels l ON l.domain = 'document_kind' AND l.code = v_kind));
    END LOOP;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE (i ->> 'ok')::boolean) INTO v_total, v_ok
    FROM jsonb_array_elements(v_items) i WHERE NOT coalesce((i ->> 'optional')::boolean, false);

  -- consecutive next stages (up to operationally_complete) with nothing mandatory missing for them or earlier;
  -- stages after customs_declaration follow customs release: never listed before a declaration is released
  v_released := EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = v_tx.id AND d.status = 'released');
  v_cur := app.code_sort('operational_status', v_tx.operational_status);
  FOR s IN SELECT l.code, l.sort FROM public.status_labels l
            WHERE l.domain = 'operational_status' AND l.sort > v_cur
              AND l.sort <= app.code_sort('operational_status', 'operationally_complete') ORDER BY l.sort LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i
                       WHERE NOT (i ->> 'ok')::boolean AND NOT coalesce((i ->> 'optional')::boolean, false)
                         AND app.code_sort('operational_status', i ->> 'required_for') <= s.sort);
    IF s.sort > app.code_sort('operational_status', 'customs_declaration') AND NOT v_released THEN
      v_limit := 'declaration_release';
      EXIT;
    END IF;
    v_ready := v_ready || to_jsonb(s.code);
  END LOOP;

  RETURN jsonb_build_object(
    'transaction_id', v_tx.id, 'stage', v_tx.operational_status,
    'score', CASE WHEN v_total = 0 THEN 100 ELSE round(100.0 * v_ok / v_total)::int END,
    'items_total', v_total, 'items_ok', v_ok,
    'missing', coalesce((SELECT jsonb_agg(i - 'ok' ORDER BY coalesce((i ->> 'optional')::boolean, false),
                                          app.code_sort('operational_status', i ->> 'required_for'), ord)
                           FROM jsonb_array_elements(v_items) WITH ORDINALITY AS x(i, ord) WHERE NOT (i ->> 'ok')::boolean), '[]'::jsonb),
    'ready_for', v_ready,
    'ready_limit', v_limit,
    'requirements_configured', v_configured,
    'advisory', true);
END $$;

-- ---------------------------------------------------------------------
-- 10. operational alerts (G3.16)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.operational_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  branch_id       uuid NOT NULL,
  transaction_id  uuid NOT NULL,
  container_id    uuid,
  subject_id      uuid,                                   -- the row behind the cause (appointment / exception / declaration / container)
  kind            text NOT NULL CHECK (kind IN ('docs_missing','appointment_soon','appointment_missed','empty_return_due',
                    'empty_return_overdue','exception_open','declaration_stalled')),
  severity        text NOT NULL CHECK (severity IN ('info','warning','critical')),
  title_ar        text NOT NULL CHECK (char_length(title_ar) <= 300),
  title_en        text CHECK (char_length(title_en) <= 300),
  due_at          timestamptz,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  dedupe_key      text NOT NULL CHECK (char_length(dedupe_key) <= 200),
  cause_active    boolean NOT NULL DEFAULT true,          -- the cause was present at the last refresh
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution      text CHECK (resolution IN ('auto','manual')),
  note            text CHECK (char_length(note) <= 1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_alerts_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT operational_alerts_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT operational_alerts_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT operational_alerts_dedupe_uniq UNIQUE (org_id, dedupe_key),
  CONSTRAINT operational_alerts_resolved_chk CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL)),
  CONSTRAINT operational_alerts_manual_chk CHECK (resolution IS DISTINCT FROM 'manual' OR note IS NOT NULL)
);
COMMENT ON TABLE public.operational_alerts IS 'G3.16 operational alerts, one row per cause (dedupe_key). refresh_alerts upserts and auto-resolves; viewing never closes one.';
CREATE INDEX IF NOT EXISTS operational_alerts_inbox_idx ON public.operational_alerts (org_id, branch_id, status, severity);
CREATE INDEX IF NOT EXISTS operational_alerts_tx_idx ON public.operational_alerts (transaction_id);

-- last refresh per org (rate limit for staff calls). Server-only table.
CREATE TABLE IF NOT EXISTS public.operational_alert_runs (
  org_id      uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_run_at timestamptz NOT NULL,
  last_run_by uuid,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.operational_alert_runs IS 'G3.16 last refresh_alerts run per org (rate limit). Written only by SECURITY DEFINER functions.';

-- current causes of one org at p_now (one row per dedupe_key)
CREATE OR REPLACE FUNCTION app.alert_causes(p_org uuid, p_now timestamptz)
RETURNS TABLE (dedupe_key text, kind text, severity text, branch_id uuid, transaction_id uuid, container_id uuid,
               subject_id uuid, title_ar text, title_en text, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH today AS (SELECT (p_now AT TIME ZONE 'Asia/Riyadh')::date AS d),
  active_tx AS (
    SELECT t.* FROM public.transactions t
     WHERE t.org_id = p_org
       AND app.code_sort('operational_status', t.operational_status) < app.code_sort('operational_status', 'operationally_complete')),
  -- mandatory documents missing for the NEXT stage of an open transaction
  docs AS (
    SELECT t.id AS tx, t.branch_id, t.ref, nx.code AS next_stage, nx.label_ar AS stage_ar, nx.label_en AS stage_en,
           string_agg(x.label_ar, '، ' ORDER BY x.document_kind) AS kinds_ar,
           string_agg(x.label_en, ', ' ORDER BY x.document_kind) AS kinds_en
      FROM active_tx t
      JOIN LATERAL (SELECT l.code, l.label_ar, l.label_en FROM public.status_labels l
                     WHERE l.domain = 'operational_status' AND l.sort > app.code_sort('operational_status', t.operational_status)
                     ORDER BY l.sort LIMIT 1) nx ON true
      JOIN LATERAL app.tx_requirements(t.id) x ON x.required_for_stage = nx.code AND NOT x.is_optional
                                               AND x.status IN ('missing','unreviewed')
     GROUP BY t.id, t.branch_id, t.ref, nx.code, nx.label_ar, nx.label_en)
  SELECT 'docs_missing:' || d.tx || ':' || d.next_stage, 'docs_missing', 'warning', d.branch_id, d.tx, NULL::uuid, NULL::uuid,
         'مستندات ناقصة قبل مرحلة «' || d.stage_ar || '» — ' || d.ref || ': ' || d.kinds_ar,
         'Documents missing before "' || d.stage_en || '" — ' || d.ref || ': ' || d.kinds_en, NULL::timestamptz
    FROM docs d
  UNION ALL
  SELECT 'appointment_soon:' || a.id, 'appointment_soon', CASE WHEN a.status = 'requested' THEN 'warning' ELSE 'info' END,
         t.branch_id, t.id, a.container_id, a.id,
         CASE WHEN a.status = 'requested' THEN 'موعد خلال 24 ساعة ولم يُؤكَّد — ' ELSE 'موعد خلال 24 ساعة — ' END || t.ref,
         CASE WHEN a.status = 'requested' THEN 'Unconfirmed appointment within 24 h — ' ELSE 'Appointment within 24 h — ' END || t.ref,
         a.appointment_at
    FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.org_id = p_org AND a.status IN ('requested','confirmed')
     AND a.appointment_at > p_now AND a.appointment_at <= p_now + interval '24 hours'
  UNION ALL
  -- window over without an outcome, or marked missed and not rescheduled / cancelled yet
  SELECT 'appointment_missed:' || a.id, 'appointment_missed', 'critical', t.branch_id, t.id, a.container_id, a.id,
         'موعد فائت يحتاج إعادة جدولة — ' || t.ref, 'Missed appointment needs a new slot — ' || t.ref, a.appointment_at
    FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.org_id = p_org
     AND (a.status = 'missed'
          OR (a.status IN ('requested','confirmed')
              AND a.appointment_at + make_interval(mins => coalesce(a.window_minutes, 0)) < p_now))
  UNION ALL
  SELECT CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue:' ELSE 'empty_return_due:' END || c.id,
         CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue' ELSE 'empty_return_due' END,
         CASE WHEN c.return_deadline < today.d THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, c.id, c.id,
         CASE WHEN c.return_deadline < today.d THEN 'تأخر إرجاع الحاوية الفارغة ' ELSE 'موعد إرجاع الحاوية الفارغة قريب ' END
           || c.container_no || ' — ' || t.ref,
         CASE WHEN c.return_deadline < today.d THEN 'Empty return overdue ' ELSE 'Empty return due ' END
           || c.container_no || ' — ' || t.ref,
         ((c.return_deadline + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')
    FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id CROSS JOIN today
   WHERE c.org_id = p_org AND c.return_status IN ('pending','evidence_submitted','disputed')
     AND c.return_deadline IS NOT NULL AND c.return_deadline <= today.d + 3
  UNION ALL
  SELECT 'exception_open:' || e.id, 'exception_open', CASE WHEN e.kind = 'customs_rejection' THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, e.container_id, e.id,
         'استثناء مفتوح: ' || coalesce(l.label_ar, e.kind) || ' — ' || t.ref,
         'Open exception: ' || coalesce(l.label_en, e.kind) || ' — ' || t.ref, NULL::timestamptz
    FROM public.operational_exceptions e JOIN public.transactions t ON t.id = e.transaction_id
    LEFT JOIN public.status_labels l ON l.domain = 'exception_kind' AND l.code = e.kind
   WHERE e.org_id = p_org AND e.status IN ('open','in_progress')
  UNION ALL
  -- an active declaration with no status change for 3 days on an open transaction
  SELECT 'declaration_stalled:' || d.id || ':' || d.status, 'declaration_stalled', 'warning', t.branch_id, t.id, NULL::uuid, d.id,
         'بيان جمركي ' || d.declaration_no || ' بلا تحديث منذ 3 أيام — ' || t.ref,
         'Declaration ' || d.declaration_no || ' not updated for 3 days — ' || t.ref, d.updated_at + interval '3 days'
    FROM public.customs_declarations d JOIN active_tx t ON t.id = d.transaction_id
   WHERE d.status IN ('draft','submitted','under_inspection') AND d.updated_at < p_now - interval '3 days'
$$;

-- refresh one org: upsert every current cause by dedupe_key, auto-resolve open / acknowledged alerts whose
-- cause is gone. A manual resolution sticks while the cause persists; a cause that went away and came back
-- reopens the alert (new occurrence). Returns counts.
CREATE OR REPLACE FUNCTION app.refresh_alerts_core(p_org uuid, p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_keys text[]; v_ins int; v_upd int; v_res int;
BEGIN
  WITH c AS (SELECT * FROM app.alert_causes(p_org, p_now)),
  up AS (
    INSERT INTO public.operational_alerts AS a (org_id, branch_id, transaction_id, container_id, subject_id, kind, severity,
                                                title_ar, title_en, due_at, dedupe_key, first_seen_at, last_seen_at)
    SELECT p_org, c.branch_id, c.transaction_id, c.container_id, c.subject_id, c.kind, c.severity, left(c.title_ar, 300),
           left(c.title_en, 300), c.due_at, c.dedupe_key, p_now, p_now
      FROM c
    ON CONFLICT (org_id, dedupe_key) DO UPDATE SET
      branch_id = EXCLUDED.branch_id, severity = EXCLUDED.severity, title_ar = EXCLUDED.title_ar,
      title_en = EXCLUDED.title_en, due_at = EXCLUDED.due_at, last_seen_at = EXCLUDED.last_seen_at,
      status          = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN 'open' ELSE a.status END,
      first_seen_at   = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN EXCLUDED.first_seen_at ELSE a.first_seen_at END,
      acknowledged_by = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN NULL ELSE a.acknowledged_by END,
      acknowledged_at = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN NULL ELSE a.acknowledged_at END,
      resolved_by     = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN NULL ELSE a.resolved_by END,
      resolved_at     = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN NULL ELSE a.resolved_at END,
      resolution      = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN NULL ELSE a.resolution END,
      note            = CASE WHEN a.status = 'resolved' AND NOT a.cause_active THEN NULL ELSE a.note END,
      cause_active    = true
    RETURNING a.dedupe_key, (xmax = 0) AS inserted)
  SELECT array_agg(up.dedupe_key), count(*) FILTER (WHERE up.inserted), count(*) FILTER (WHERE NOT up.inserted)
    INTO v_keys, v_ins, v_upd FROM up;

  WITH gone AS (
    UPDATE public.operational_alerts a SET
      cause_active = false,
      status       = CASE WHEN a.status IN ('open','acknowledged') THEN 'resolved' ELSE a.status END,
      resolved_at  = CASE WHEN a.status IN ('open','acknowledged') THEN p_now ELSE a.resolved_at END,
      resolution   = CASE WHEN a.status IN ('open','acknowledged') THEN 'auto' ELSE a.resolution END
     WHERE a.org_id = p_org AND a.cause_active AND NOT (a.dedupe_key = ANY (coalesce(v_keys, '{}'::text[])))
    RETURNING 1)
  SELECT count(*) INTO v_res FROM gone;

  RETURN jsonb_build_object('org_id', p_org, 'at', p_now, 'active', coalesce(cardinality(v_keys), 0),
                            'inserted', coalesce(v_ins, 0), 'updated', coalesce(v_upd, 0), 'resolved', coalesce(v_res, 0));
END $$;

-- refresh_alerts(p_org) — staff of the org; at most once a minute per org (later calls in that minute
-- return refreshed:false, rate_limited:true, retry_after_seconds — no error). Returns org-wide counts
-- (opened, resolved), no per-branch data.
CREATE OR REPLACE FUNCTION public.refresh_alerts(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_last timestamptz; v_r jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  INSERT INTO public.operational_alert_runs (org_id, last_run_at) VALUES (p_org, '-infinity') ON CONFLICT (org_id) DO NOTHING;
  SELECT r.last_run_at INTO v_last FROM public.operational_alert_runs r WHERE r.org_id = p_org FOR UPDATE;
  IF v_last > now() - interval '1 minute' THEN
    RETURN jsonb_build_object('refreshed', false, 'rate_limited', true, 'last_run_at', v_last,
                              'retry_after_seconds', ceil(extract(epoch FROM (v_last + interval '1 minute' - now())))::int);
  END IF;
  v_r := app.refresh_alerts_core(p_org, now());
  UPDATE public.operational_alert_runs r SET last_run_at = now(), last_run_by = auth.uid(), last_result = v_r WHERE r.org_id = p_org;
  -- org-wide counts only (no per-branch data): new occurrences and auto-resolved alerts of this run
  RETURN jsonb_build_object('refreshed', true, 'rate_limited', false, 'last_run_at', now(),
                            'opened', coalesce((v_r ->> 'inserted')::int, 0), 'resolved', coalesce((v_r ->> 'resolved')::int, 0));
END $$;

-- scheduled entry point (pg_cron, SQL Editor): every active org
CREATE OR REPLACE FUNCTION app.refresh_all_alerts() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_n int := 0; v_res jsonb;
BEGIN
  FOR r IN SELECT o.id FROM public.organizations o WHERE o.is_active ORDER BY o.id LOOP
    v_res := app.refresh_alerts_core(r.id, now());
    INSERT INTO public.operational_alert_runs (org_id, last_run_at, last_result) VALUES (r.id, now(), v_res)
    ON CONFLICT (org_id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_run_by = NULL, last_result = EXCLUDED.last_result;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION app.alert_json(a public.operational_alerts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', a.id, 'org_id', a.org_id, 'branch_id', a.branch_id, 'transaction_id', a.transaction_id,
    'container_id', a.container_id, 'subject_id', a.subject_id, 'kind', a.kind, 'severity', a.severity,
    'title_ar', a.title_ar, 'title_en', a.title_en, 'due_at', a.due_at, 'status', a.status, 'dedupe_key', a.dedupe_key,
    'cause_active', a.cause_active, 'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at,
    'acknowledged_by', a.acknowledged_by, 'acknowledged_at', a.acknowledged_at, 'resolved_by', a.resolved_by,
    'resolved_at', a.resolved_at, 'resolution', a.resolution, 'note', a.note)
$$;

-- list_alerts(p_org, {status? active (default: open + acknowledged) | open | acknowledged | resolved | all,
--                     severity?, kind?, transaction_id?, branch_id?, limit ≤ 200 (100), offset?})
-- Branch-scoped exactly like the table policy (through the parent transaction; the alert's own branch_id
-- is only an inbox hint). Read-only: viewing never changes an alert.
CREATE OR REPLACE FUNCTION public.list_alerts(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_status text; v_sev text; v_kind text; v_tx uuid; v_br uuid;
  v_limit int; v_offset int; v_items jsonb; v_counts jsonb; v_total int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  PERFORM app.only_keys(f, ARRAY['status','severity','kind','transaction_id','branch_id','limit','offset']);
  v_status := coalesce(app.ptext(f, 'status', 20), 'active');
  IF v_status NOT IN ('active','open','acknowledged','resolved','all') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_sev := app.ptext(f, 'severity', 20);
  IF v_sev IS NOT NULL AND v_sev NOT IN ('info','warning','critical') THEN PERFORM app.fail('MRS_INVALID', 'severity'); END IF;
  v_kind := app.ptext(f, 'kind', 40);
  IF v_kind IS NOT NULL AND NOT app.is_code('alert_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_tx := app.puuid(f, 'transaction_id');
  v_br := app.puuid(f, 'branch_id');
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 100);
  v_offset := coalesce(app.pnum(f, 'offset', 100000)::int, 0);

  WITH s AS (
    SELECT a AS al, a.id, a.severity, a.due_at, a.first_seen_at, t.ref, c.container_no,
           CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END AS sev_rank
      FROM public.operational_alerts a
      JOIN public.transactions t ON t.id = a.transaction_id
      LEFT JOIN public.containers c ON c.id = a.container_id
     WHERE a.org_id = p_org AND app.has_tx_role(a.transaction_id, app.staff_roles())
       AND (v_status = 'all' OR (v_status = 'active' AND a.status IN ('open','acknowledged')) OR a.status = v_status)
       AND (v_sev IS NULL OR a.severity = v_sev) AND (v_kind IS NULL OR a.kind = v_kind)
       AND (v_tx IS NULL OR a.transaction_id = v_tx) AND (v_br IS NULL OR t.branch_id = v_br)),
  pg AS (
    SELECT s.* FROM s ORDER BY s.sev_rank, s.due_at NULLS LAST, s.first_seen_at DESC, s.id
     LIMIT v_limit OFFSET v_offset)
  SELECT (SELECT coalesce(jsonb_agg(app.alert_json(pg.al) || jsonb_build_object('ref', pg.ref, 'container_no', pg.container_no)
               ORDER BY pg.sev_rank, pg.due_at NULLS LAST, pg.first_seen_at DESC, pg.id), '[]'::jsonb) FROM pg),
         (SELECT jsonb_build_object('critical', count(*) FILTER (WHERE s.severity = 'critical'),
                                    'warning', count(*) FILTER (WHERE s.severity = 'warning'),
                                    'info', count(*) FILTER (WHERE s.severity = 'info')) FROM s),
         (SELECT count(*) FROM s)
    INTO v_items, v_counts, v_total;
  RETURN jsonb_build_object('items', v_items, 'counts', v_counts, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
END $$;

-- ack_alert(p_id) — "seen, someone is on it"; the alert stays open until its cause is fixed or it is resolved manually
CREATE OR REPLACE FUNCTION public.ack_alert(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.operational_alerts;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_a FROM public.operational_alerts a WHERE a.id = p_id FOR UPDATE;
  IF v_a.id IS NULL OR NOT app.has_tx_role(v_a.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_a.status = 'acknowledged' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF v_a.status = 'resolved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'resolved'); END IF;
  UPDATE public.operational_alerts a SET status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_at = now()
   WHERE a.id = v_a.id RETURNING * INTO v_a;
  RETURN app.alert_json(v_a);
END $$;

-- resolve_alert(p_id, p_note) — manual close with a mandatory note
CREATE OR REPLACE FUNCTION public.resolve_alert(p_id uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.operational_alerts; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_a FROM public.operational_alerts a WHERE a.id = p_id FOR UPDATE;
  IF v_a.id IS NULL OR NOT app.has_tx_role(v_a.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v_note) > 1000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF v_a.status = 'resolved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'resolved'); END IF;
  UPDATE public.operational_alerts a SET status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
         resolution = 'manual', note = v_note
   WHERE a.id = v_a.id RETURNING * INTO v_a;
  RETURN app.alert_json(v_a);
END $$;

-- every 15 minutes when pg_cron is enabled (Supabase: Database → Extensions → pg_cron).
-- Without pg_cron (local PGlite, tests) staff use "refresh now" (refresh_alerts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.schedule('marsa_refresh_alerts', '*/15 * * * *', 'SELECT app.refresh_all_alerts()')$q$;
  END IF;
END $$;

-- a transaction moved to another branch: its alerts follow at once (inbox hint), and an alert the OLD
-- branch acknowledged or closed by hand while its cause is still active is handed to the new branch open.
CREATE OR REPLACE FUNCTION app.tg_transactions_alert_branch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    UPDATE public.operational_alerts a SET branch_id = NEW.branch_id WHERE a.transaction_id = NEW.id;
    UPDATE public.operational_alerts a SET status = 'open', acknowledged_by = NULL, acknowledged_at = NULL,
           resolved_by = NULL, resolved_at = NULL, resolution = NULL, note = NULL
     WHERE a.transaction_id = NEW.id AND a.cause_active
       AND (a.status = 'acknowledged' OR (a.status = 'resolved' AND a.resolution = 'manual'));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_alert_branch ON public.transactions;
CREATE TRIGGER trg_alert_branch AFTER UPDATE OF branch_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_alert_branch();

-- ---------------------------------------------------------------------
-- 11. generic triggers (updated_at, creator stamp, immutables, audit)
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_requirements','port_appointments','transport_trips','operational_exceptions','operational_alerts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
  END LOOP;
  -- direct writes (RLS): requirements only
  DROP TRIGGER IF EXISTS trg_stamp ON public.document_requirements;
  CREATE TRIGGER trg_stamp BEFORE INSERT ON public.document_requirements FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();
  DROP TRIGGER IF EXISTS trg_guard ON public.document_requirements;
  CREATE TRIGGER trg_guard BEFORE UPDATE ON public.document_requirements
    FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id', 'org_id', 'created_by', 'created_at');
  FOREACH t IN ARRAY ARRAY['document_requirements','port_appointments','transport_trips','operational_exceptions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
END $$;
-- alerts: audit the occurrences and decisions, not every refresh (last_seen_at moves every 15 minutes)
DROP TRIGGER IF EXISTS trg_audit ON public.operational_alerts;
CREATE TRIGGER trg_audit AFTER UPDATE ON public.operational_alerts FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.note IS DISTINCT FROM NEW.note OR OLD.severity IS DISTINCT FROM NEW.severity)
  EXECUTE FUNCTION app.tg_audit();
DROP TRIGGER IF EXISTS trg_audit_ins ON public.operational_alerts;
CREATE TRIGGER trg_audit_ins AFTER INSERT OR DELETE ON public.operational_alerts FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

-- ---------------------------------------------------------------------
-- 12. RLS, policies, grants
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_requirements','port_appointments','transport_trips','operational_exceptions',
                           'operational_alerts','operational_alert_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated', t);
  END LOOP;
END $$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['document_requirements','port_appointments','transport_trips',
  'operational_exceptions','operational_alerts','operational_alert_runs']) t;

-- requirements: staff read; the org admin edits directly (no DELETE: deactivate with is_active)
CREATE POLICY document_requirements_select ON public.document_requirements FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY document_requirements_insert ON public.document_requirements FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['admin']));
CREATE POLICY document_requirements_update ON public.document_requirements FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['admin'])) WITH CHECK (app.has_role(org_id, ARRAY['admin']));
REVOKE DELETE ON public.document_requirements FROM authenticated;

-- state machines: staff of the transaction's branch read, RPCs write. Clients: none (portal gets events).
CREATE POLICY port_appointments_select ON public.port_appointments FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
CREATE POLICY transport_trips_select ON public.transport_trips FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
CREATE POLICY operational_exceptions_select ON public.operational_exceptions FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
CREATE POLICY operational_alerts_select ON public.operational_alerts FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
REVOKE ALL ON public.port_appointments, public.transport_trips, public.operational_exceptions,
              public.operational_alerts, public.operational_alert_runs FROM authenticated;
GRANT SELECT ON public.port_appointments, public.operational_exceptions, public.operational_alerts TO authenticated;
-- trips: cost / sell outside the SELECT grant (fail closed: a later column is hidden until added here)
DO $$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'transport_trips'
     AND NOT (c.column_name = ANY (ARRAY['cost_amount','cost_currency','sell_amount','sell_currency','cost_basis']));
  EXECUTE format('GRANT SELECT (%s) ON public.transport_trips TO authenticated', v_cols);
END $$;

-- ---------------------------------------------------------------------
-- 13. function privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.pts(jsonb, text), app.senior_ops_roles(), app.trip_finance_roles(), app.trip_finance_keys(),
  app.g3_check_party(uuid, uuid, text[], text), app.g3_check_fleet(uuid, uuid, uuid, uuid),
  app.g3_check_container(uuid, uuid), app.g3_check_document(uuid, uuid, text),
  app.tg_document_requirements_before(), app.seed_document_requirements(uuid), app.tx_requirements(uuid),
  app.appt_json(public.port_appointments), app.appt_event(public.port_appointments, text, text, text, jsonb),
  app.appt_fields(jsonb, public.transactions),
  app.trip_json(public.transport_trips), app.trip_event(public.transport_trips, text, text, text, jsonb),
  app.trip_fields(jsonb, public.transactions), app.tg_containers_g3b_before(),
  app.exc_json(public.operational_exceptions), app.exc_event(public.operational_exceptions, text, text, text),
  app.exc_insert(public.transactions, text, text, text, uuid, uuid, uuid, numeric, text, timestamptz),
  app.alert_causes(uuid, timestamptz), app.refresh_alerts_core(uuid, timestamptz), app.refresh_all_alerts(),
  app.alert_json(public.operational_alerts), app.tg_transactions_alert_branch()
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.tx_checklist(uuid), public.set_transaction_status(uuid, text, text, uuid, boolean), public.platform_create_org(jsonb),
  public.create_appointment(jsonb, uuid), public.reschedule_appointment(uuid, jsonb, text, uuid),
  public.set_appointment_status(uuid, text, text),
  public.create_trip(jsonb, uuid), public.update_trip(uuid, jsonb), public.set_trip_status(uuid, text, timestamptz, text),
  public.trip_finance(uuid[]), public.set_container_return(uuid, jsonb),
  public.create_exception(jsonb, uuid), public.resolve_exception(uuid, text, text),
  public.cancel_declaration(uuid, text, jsonb), public.transaction_completeness(uuid),
  public.refresh_alerts(uuid), public.list_alerts(uuid, jsonb), public.ack_alert(uuid), public.resolve_alert(uuid, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.tx_checklist(uuid), public.set_transaction_status(uuid, text, text, uuid, boolean), public.platform_create_org(jsonb),
  public.create_appointment(jsonb, uuid), public.reschedule_appointment(uuid, jsonb, text, uuid),
  public.set_appointment_status(uuid, text, text),
  public.create_trip(jsonb, uuid), public.update_trip(uuid, jsonb), public.set_trip_status(uuid, text, timestamptz, text),
  public.trip_finance(uuid[]), public.set_container_return(uuid, jsonb),
  public.create_exception(jsonb, uuid), public.resolve_exception(uuid, text, text),
  public.cancel_declaration(uuid, text, jsonb), public.transaction_completeness(uuid),
  public.refresh_alerts(uuid), public.list_alerts(uuid, jsonb), public.ack_alert(uuid), public.resolve_alert(uuid, text)
TO authenticated;
