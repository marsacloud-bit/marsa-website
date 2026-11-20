-- =====================================================================
-- 20261204000100_tx_stage_sets — the owner's transaction stages as per-type SETTINGS (billing stays manual)
-- (2026-11-19, owner request docs/owner/transaction-stages-request.md, step م2; branch owner/ui-reorg)
--   The owner sees his stages (جديدة · نشطة · منتهية تشغيليًا · إرجاع الحاوية الفارغة · تحت الفوترة · تمت الفوترة ·
--   منتهية), and future transaction kinds (air, export, transit) need their own sequences without a code or CHECK change.
--   The 10 internal stages of transactions.operational_status (CHECK of 20261031000200, every module reads them) stay the
--   ENGINE; what the staff see is now a per-org, per-transaction-type list of steps, each grouping internal stages:
--   1. public.tx_stage_sets: one set per org and transaction kind. operation / mode / transaction_type / cargo_unit_type
--      NULL = any; codes are free lower-case words (a format check only, no value list), so a new kind (e.g. transit) is a
--      row, not a migration. The most specific active set wins (more non-NULL criteria first).
--   2. public.tx_stage_steps: the ordered steps of a set: code, Arabic / English label, sort_order, internal_codes (each an
--      operational_status code of status_labels, validated by trigger; a step may group several, e.g. الموعد + النقل).
--      RLS like document_requirements: staff of the org read; the org admin inserts / updates; no DELETE (is_active).
--      Audited (app.tg_audit), updated_at / created_by stamped, id / org_id / created_* immutable.
--   3. app.default_stage_steps() = the owner's seven steps (also the fallback of an org without a set);
--      app.seed_tx_stage_sets(org) gives an org without sets one default set (an org that has sets is left alone); every
--      existing org is seeded once below. A new org (platform_create_org) has no set yet and shows the same defaults
--      through the fallback until its admin saves one.
--   4. app.tx_stage_set_for(tx): the set that applies to a transaction (NULL = the defaults).
--   5. public.tx_lifecycle(tx) (20261118000100 body, re-created): the same keys + 'steps' (the applicable set's steps with
--      done / current / todo / skipped, the first reached date, automatic flag, the current internal stage as 'detail')
--      and 'stage_set' {id, name_ar, name_en}; next.manual follows 6.
--   6. NO automatic move to billing (owner decision 2026-11-20: «تحت الفوترة» stays MANUAL, never automatic; «مغلقة»
--      stays manual; an empty return that is not verified still blocks billing). app.advance_tx_status and
--      app.tg_containers_legacy_tx are NOT re-created: the deployed 20261118000100 bodies stay (advance_tx_status refuses
--      under_billing / closed whatever the cause; a container return moves to empty_return only). operationally_complete
--      stays manual for a container transaction too (deployed behaviour): the request doc asks for «بطاقة الموعد ←
--      منتهية تشغيليًا» (owner step o_opdone = internal appointment / transport, already automatic) and «إرجاع الفارغ ←
--      الفوترة» (now manual by the owner's decision); the internal operationally_complete belongs to the owner step
--      «تحت الفوترة» (o_under_billing), so moving there by itself would show «تحت الفوترة» automatically.
--      next.manual reports reality: in_progress, under_billing, closed always manual; operationally_complete manual for a
--      container transaction, and for Ro-Ro automatic only while its release (its one automatic path) has not happened.
--   Stage 1 of the owner (new on B/L + invoice) and stage 2 (active on the preliminary declaration) already happen: a new
--   transaction is 'new'; a declaration added → customs_declaration (20261118000100). The appointment card approval →
--   appointment (inside «منتهية تشغيليًا»), a verified empty return → «إرجاع الحاوية الفارغة» (unchanged).
--   7a. conversion: app.convert_keep_tables (20261117000100 body, re-created) + the two settings tables (kept, like
--      document_requirements).
--   CREATE OR REPLACE keeps each re-created function's privileges (tx_lifecycle: authenticated).
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS + CREATE / ON CONFLICT / seed only orgs without a set).
--   Data: seeds one default stage set (7 steps) per existing organisation; changes no existing row.
--   Re-pasting 20261118000100 after this file drops 'steps' / 'stage_set' from tx_lifecycle: re-paste this file
--   straight after.
--   Down-path: re-create public.tx_lifecycle from 20261118000100 and app.convert_keep_tables from 20261117000100 (their
--   bodies, verbatim); DROP FUNCTION app.tx_stage_set_for(uuid), app.seed_tx_stage_sets(uuid),
--   app.default_stage_steps(), app.tg_tx_stage_steps_before(), app.tg_tx_stage_sets_before(); DROP TABLE
--   public.tx_stage_steps, public.tx_stage_sets; DELETE FROM public.schema_versions WHERE version = '20261204000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261203000100') THEN
    RAISE EXCEPTION 'TX STAGE SETS preflight: apply draft_client_hidden first (schema_versions lacks 20261203000100)';
  END IF;
  IF to_regprocedure('public.tx_lifecycle(uuid)') IS NULL OR to_regprocedure('app.advance_tx_status(uuid,text,text)') IS NULL
     OR to_regprocedure('app.tg_audit()') IS NULL THEN
    RAISE EXCEPTION 'TX STAGE SETS preflight: tx_lifecycle / advance_tx_status (20261118000100) or tg_audit missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261204000100', 'tx_stage_sets')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. stage sets (one per org and transaction kind)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tx_stage_sets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name_ar          text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 120),
  name_en          text CHECK (char_length(name_en) <= 120),
  operation        text CHECK (operation ~ '^[a-z][a-z0-9_]{1,29}$'),         -- NULL = any (import, export, …)
  mode             text CHECK (mode ~ '^[a-z][a-z0-9_]{1,29}$'),              -- NULL = any (sea, air, land, …)
  transaction_type text CHECK (transaction_type ~ '^[a-z][a-z0-9_]{1,29}$'),  -- NULL = any (normal, re_export, transit, …)
  cargo_unit_type  text CHECK (cargo_unit_type ~ '^[a-z][a-z0-9_]{1,29}$'),   -- NULL = any (container, roro, …)
  is_active        boolean NOT NULL DEFAULT true,
  note             text CHECK (char_length(note) <= 500),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.tx_stage_sets IS 'Owner stages (20261204000100): per-org stage sequence for a transaction kind (NULL criteria = any; most specific active set wins). Steps in tx_stage_steps.';
CREATE UNIQUE INDEX IF NOT EXISTS tx_stage_sets_kind_uidx ON public.tx_stage_sets
  (org_id, coalesce(operation, ''), coalesce(mode, ''), coalesce(transaction_type, ''), coalesce(cargo_unit_type, '')) WHERE is_active;

CREATE OR REPLACE FUNCTION app.tg_tx_stage_sets_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.name_ar := btrim(NEW.name_ar);
  NEW.name_en := nullif(btrim(coalesce(NEW.name_en, '')), '');
  NEW.note := nullif(btrim(coalesce(NEW.note, '')), '');
  NEW.operation := nullif(lower(btrim(coalesce(NEW.operation, ''))), '');
  NEW.mode := nullif(lower(btrim(coalesce(NEW.mode, ''))), '');
  NEW.transaction_type := nullif(lower(btrim(coalesce(NEW.transaction_type, ''))), '');
  NEW.cargo_unit_type := nullif(lower(btrim(coalesce(NEW.cargo_unit_type, ''))), '');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.tx_stage_sets;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.tx_stage_sets
  FOR EACH ROW EXECUTE FUNCTION app.tg_tx_stage_sets_before();

-- ---------------------------------------------------------------------
-- 2. the steps of a set
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tx_stage_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  set_id         uuid NOT NULL,
  code           text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  label_ar       text NOT NULL CHECK (char_length(label_ar) BETWEEN 1 AND 80),
  label_en       text CHECK (char_length(label_en) <= 80),
  sort_order     int NOT NULL CHECK (sort_order BETWEEN 1 AND 999),
  internal_codes text[] NOT NULL CHECK (cardinality(internal_codes) BETWEEN 1 AND 10),
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (set_id, org_id) REFERENCES public.tx_stage_sets (id, org_id) ON DELETE RESTRICT,
  UNIQUE (set_id, code)
);
COMMENT ON TABLE public.tx_stage_steps IS 'Owner stages (20261204000100): ordered steps of a tx_stage_set; each groups one or more operational_status codes (internal_codes).';
CREATE INDEX IF NOT EXISTS tx_stage_steps_set_idx ON public.tx_stage_steps (set_id, sort_order);

-- every internal code is a known operational_status (status_labels, readable by every role), none twice; invoker rights
CREATE OR REPLACE FUNCTION app.tg_tx_stage_steps_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.label_ar := btrim(NEW.label_ar);
  NEW.label_en := nullif(btrim(coalesce(NEW.label_en, '')), '');
  IF EXISTS (SELECT 1 FROM unnest(NEW.internal_codes) c
              WHERE c IS NULL OR NOT EXISTS (SELECT 1 FROM public.status_labels l WHERE l.domain = 'operational_status' AND l.code = c))
     OR (SELECT count(DISTINCT c) FROM unnest(NEW.internal_codes) c) <> cardinality(NEW.internal_codes) THEN
    PERFORM app.fail('MRS_INVALID', 'internal_codes');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.tx_stage_steps;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.tx_stage_steps
  FOR EACH ROW EXECUTE FUNCTION app.tg_tx_stage_steps_before();

-- generic triggers (as document_requirements: touch, creator stamp, immutables, audit)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tx_stage_sets','tx_stage_steps'] LOOP
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
DROP TRIGGER IF EXISTS trg_guard ON public.tx_stage_steps;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.tx_stage_steps
  FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id', 'org_id', 'set_id', 'created_by', 'created_at');

SELECT app.drop_policies(t) FROM unnest(ARRAY['tx_stage_sets','tx_stage_steps']) t;
-- staff read; the org admin edits directly (no DELETE: deactivate with is_active)
CREATE POLICY tx_stage_sets_select ON public.tx_stage_sets FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY tx_stage_sets_insert ON public.tx_stage_sets FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['admin']));
CREATE POLICY tx_stage_sets_update ON public.tx_stage_sets FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['admin'])) WITH CHECK (app.has_role(org_id, ARRAY['admin']));
CREATE POLICY tx_stage_steps_select ON public.tx_stage_steps FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY tx_stage_steps_insert ON public.tx_stage_steps FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['admin']));
CREATE POLICY tx_stage_steps_update ON public.tx_stage_steps FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['admin'])) WITH CHECK (app.has_role(org_id, ARRAY['admin']));
REVOKE DELETE ON public.tx_stage_sets FROM authenticated;
REVOKE DELETE ON public.tx_stage_steps FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tx_stage_sets TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tx_stage_steps TO authenticated;

-- ---------------------------------------------------------------------
-- 3. the owner's default steps + seeding
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.default_stage_steps()
RETURNS TABLE (code text, label_ar text, label_en text, sort_order int, internal_codes text[])
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT v.code, v.label_ar, v.label_en, v.sort_order, v.internal_codes FROM (VALUES
    ('o_new',           'جديدة',                  'New',                     1, ARRAY['new','in_progress']),
    ('o_active',        'نشطة',                   'Active',                  2, ARRAY['customs_declaration']),
    ('o_opdone',        'منتهية تشغيليًا',         'Operationally complete',  3, ARRAY['appointment','transport']),
    ('o_empty',         'إرجاع الحاوية الفارغة',   'Empty container return',  4, ARRAY['empty_return']),
    ('o_under_billing', 'تحت الفوترة',            'Under billing',           5, ARRAY['operationally_complete','under_billing']),
    ('o_billed',        'تمت الفوترة',            'Billed',                  6, ARRAY['billed']),
    ('o_closed',        'منتهية',                 'Finished',                7, ARRAY['closed'])
  ) AS v(code, label_ar, label_en, sort_order, internal_codes)
$$;

CREATE OR REPLACE FUNCTION app.seed_tx_stage_sets(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_set uuid; v_n int;
BEGIN
  IF p_org IS NULL OR EXISTS (SELECT 1 FROM public.tx_stage_sets s WHERE s.org_id = p_org) THEN RETURN 0; END IF;
  INSERT INTO public.tx_stage_sets (org_id, name_ar, name_en, note)
  VALUES (p_org, 'المراحل الافتراضية', 'Default stages', 'لكل المعاملات ما لم تُعرَّف مجموعة أخص بحسب نوع المعاملة')
  RETURNING id INTO v_set;
  INSERT INTO public.tx_stage_steps (org_id, set_id, code, label_ar, label_en, sort_order, internal_codes)
  SELECT p_org, v_set, d.code, d.label_ar, d.label_en, d.sort_order, d.internal_codes FROM app.default_stage_steps() d;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- existing orgs get the defaults once (an org that already has a set is left alone)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT o.id FROM public.organizations o ORDER BY o.created_at, o.id LOOP
    PERFORM app.seed_tx_stage_sets(r.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 4. the set that applies to a transaction (NULL = the defaults)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tx_stage_set_for(p_tx uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id
    FROM public.transactions t
    JOIN public.tx_stage_sets s ON s.org_id = t.org_id AND s.is_active
   WHERE t.id = p_tx
     AND (s.operation IS NULL OR s.operation = t.operation)
     AND (s.mode IS NULL OR s.mode = t.mode)
     AND (s.transaction_type IS NULL OR s.transaction_type = coalesce(t.transaction_type, 'normal'))
     AND (s.cargo_unit_type IS NULL OR s.cargo_unit_type = coalesce(t.cargo_unit_type, 'container'))
     AND EXISTS (SELECT 1 FROM public.tx_stage_steps x WHERE x.set_id = s.id AND x.is_active)
   ORDER BY ((s.operation IS NOT NULL)::int + (s.mode IS NOT NULL)::int + (s.transaction_type IS NOT NULL)::int
             + (s.cargo_unit_type IS NOT NULL)::int) DESC, s.created_at, s.id
   LIMIT 1
$$;

-- ---------------------------------------------------------------------
-- 5. tx_lifecycle + the owner steps
-- ---------------------------------------------------------------------
-- public.tx_lifecycle from 20261118000100 + 'steps' / 'stage_set'; next.manual (6.): in_progress, under_billing and closed
-- always manual (no automatic move ever reaches them); operationally_complete manual on a container transaction, and on a
-- Ro-Ro one once a declaration is released (its release trigger already ran, nothing moves it by itself any more).
CREATE OR REPLACE FUNCTION public.tx_lifecycle(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_cur int; v_next text; v_open int; v_docs jsonb; v_pending jsonb;
        v_stages jsonb; v_set uuid; v_steps jsonb; v_set_json jsonb;
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
  SELECT jsonb_agg(jsonb_build_object(
      'code', l.code, 'sort', l.sort, 'label_ar', l.label_ar, 'label_en', l.label_en,
      'state', CASE WHEN l.sort = v_cur THEN 'current'
                    WHEN v_tx.cargo_unit_type = 'roro' AND l.code IN ('appointment','empty_return') AND e.created_at IS NULL
                      THEN 'skipped'
                    WHEN l.sort < v_cur THEN 'done' ELSE 'todo' END,
      'reached_at', e.created_at, 'auto', coalesce((e.payload ->> 'auto')::boolean, false), 'cause', e.payload ->> 'cause')
      ORDER BY l.sort) INTO v_stages
    FROM public.status_labels l
    LEFT JOIN LATERAL (SELECT x.created_at, x.payload FROM public.transaction_events x
                        WHERE x.transaction_id = v_tx.id AND x.event_type IN ('created','operational_status') AND x.to_status = l.code
                        ORDER BY x.created_at, x.id LIMIT 1) e ON true
   WHERE l.domain = 'operational_status';
  -- the owner steps: the applicable set (or the defaults), each step = its internal stages grouped
  v_set := app.tx_stage_set_for(v_tx.id);
  SELECT CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id', s.id, 'name_ar', s.name_ar, 'name_en', s.name_en) END
    INTO v_set_json FROM public.tx_stage_sets s WHERE s.id = v_set;
  WITH st AS (
    SELECT e ->> 'code' AS code, e ->> 'state' AS state, (e ->> 'sort')::int AS sort, e ->> 'label_ar' AS label_ar,
           e ->> 'label_en' AS label_en, (e ->> 'reached_at')::timestamptz AS reached_at,
           coalesce((e ->> 'auto')::boolean, false) AS auto, e ->> 'cause' AS cause
      FROM jsonb_array_elements(coalesce(v_stages, '[]'::jsonb)) e
  ), def AS (
    SELECT x.code, x.label_ar, x.label_en, x.sort_order, x.internal_codes
      FROM public.tx_stage_steps x WHERE v_set IS NOT NULL AND x.set_id = v_set AND x.is_active
    UNION ALL
    SELECT d.code, d.label_ar, d.label_en, d.sort_order, d.internal_codes FROM app.default_stage_steps() d WHERE v_set IS NULL
  ), g AS (
    SELECT d.code, d.label_ar, d.label_en, d.sort_order, d.internal_codes,
           count(st.code) AS n,
           count(*) FILTER (WHERE st.state = 'current') AS n_cur,
           count(*) FILTER (WHERE st.state = 'done') AS n_done,
           count(*) FILTER (WHERE st.state = 'skipped') AS n_skip,
           min(st.reached_at) AS reached_at,
           (array_agg(st.code ORDER BY st.sort) FILTER (WHERE st.state = 'current'))[1] AS cur_code,
           (array_agg(st.label_ar ORDER BY st.sort) FILTER (WHERE st.state = 'current'))[1] AS cur_ar,
           (array_agg(st.label_en ORDER BY st.sort) FILTER (WHERE st.state = 'current'))[1] AS cur_en,
           (array_agg(st.auto ORDER BY st.sort DESC) FILTER (WHERE st.state IN ('current','done')))[1] AS auto,
           (array_agg(st.cause ORDER BY st.sort DESC) FILTER (WHERE st.state IN ('current','done')))[1] AS cause
      FROM def d LEFT JOIN st ON st.code = ANY (d.internal_codes)
     GROUP BY d.code, d.label_ar, d.label_en, d.sort_order, d.internal_codes
  )
  SELECT jsonb_agg(jsonb_build_object(
      'code', g.code, 'label_ar', g.label_ar, 'label_en', g.label_en, 'sort', g.sort_order, 'stages', to_jsonb(g.internal_codes),
      'state', CASE WHEN g.n_cur > 0 THEN 'current'
                    WHEN g.n = 0 THEN 'todo'
                    WHEN g.n_skip = g.n THEN 'skipped'
                    WHEN g.n_done > 0 AND g.n_done + g.n_skip = g.n THEN 'done'
                    ELSE 'todo' END,
      'detail', CASE WHEN g.n_cur > 0 AND g.n > 1 THEN jsonb_build_object('code', g.cur_code, 'label_ar', g.cur_ar, 'label_en', g.cur_en) END,
      'reached_at', g.reached_at, 'auto', coalesce(g.auto, false), 'cause', g.cause)
      ORDER BY g.sort_order, g.code) INTO v_steps
    FROM g;
  RETURN jsonb_build_object(
    'transaction_id', v_tx.id, 'ref', v_tx.ref, 'operational_status', v_tx.operational_status,
    'status_changed_at', v_tx.status_changed_at, 'cargo_unit_type', v_tx.cargo_unit_type,
    'transaction_type', v_tx.transaction_type, 'transport_mode', v_tx.transport_mode,
    'cancelled', v_tx.cancelled_at IS NOT NULL, 'cancelled_at', v_tx.cancelled_at,
    'stages', v_stages,
    'steps', coalesce(v_steps, '[]'::jsonb),
    'stage_set', v_set_json,
    'next', CASE WHEN v_next IS NULL THEN NULL ELSE jsonb_build_object(
        'code', v_next, 'manual', v_next IN ('in_progress','under_billing','closed')
                                  OR (v_next = 'operationally_complete'
                                      AND (coalesce(v_tx.cargo_unit_type, 'container') <> 'roro'
                                           OR EXISTS (SELECT 1 FROM public.customs_declarations d
                                                       WHERE d.transaction_id = v_tx.id AND d.status = 'released'))),
        'containers_not_returned', CASE WHEN app.code_sort('operational_status', v_next)
                                            >= app.code_sort('operational_status', 'operationally_complete') THEN v_open ELSE 0 END,
        'docs_missing', v_docs) END,
    'pending_containers', v_pending,
    'follow_up_required', jsonb_array_length(v_pending) > 0 AND v_cur >= app.code_sort('operational_status', 'transport'));
END $$;

-- ---------------------------------------------------------------------
-- 7a. conversion (20261115000100 convert_in_place): the stage settings are KEPT like document_requirements —
--     app.convert_keep_tables re-created (20261117000100 body + public.tx_stage_sets, public.tx_stage_steps)
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
    -- append-only / log tables
    'public.audit_log', 'public.report_exports', 'app.ai_usage', 'public.operational_alert_runs', 'public.client_errors'
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 7. privileges of the new helpers (app schema: not exposed through the API)
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.seed_tx_stage_sets(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.tx_stage_set_for(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION app.default_stage_steps() FROM PUBLIC, anon;
