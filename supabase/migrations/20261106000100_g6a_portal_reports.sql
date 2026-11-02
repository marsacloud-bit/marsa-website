-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261106000100 — G6a: client portal invoices, role dashboards,
-- advanced search, operational reports and the export log (docs/online/G6A_SPEC.md). Builds on G5.
--
-- READ SIDE ONLY. Adds readers and one append-only log; changes no operational, cost, billing
-- or sync logic, adds no column to an existing table, replaces no existing function or policy,
-- never contacts Daftra.
--   P. preflight (G5 applied) + schema_versions row
--   0. dictionaries   report_kind, export_format, search_date_field, portal_payment_status
--   1. helpers        app.mgmt_roles, app.rpt_audit_roles, app.rpt_* (all revoked from API roles)
--   2. indexes        btree always; GIN trigram only when pg_trgm is ALREADY installed (never created here)
--   3. report_exports append-only export audit (who, report, format, filters, row count — no data)
--   4. RPCs           search_records, report_transactions, report_containers, report_trips,
--                     dash_ops, dash_finance, dash_management, portal_invoices,
--                     log_report_export, list_report_exports
--   5. privileges
-- Every reader filters inside SQL: org membership, branch scope per row (parent transaction),
-- role (finance figures only with fin_read at the row's branch, trip cost / sell only with
-- trip_finance at the row's branch, clients only their own client_id). Dates: Asia/Riyadh.
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

-- Paste guard: a blocked index build fails fast and rolls the whole file back (re-run it) instead of stalling the
-- app's writers behind it. Local to the current transaction (the SQL editor / migration runner transaction).
-- CREATE INDEX CONCURRENTLY is not possible inside that transaction.
SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261105000100') THEN
    RAISE EXCEPTION 'G6a preflight: apply G5 first (schema_versions lacks 20261105000100 g5_daftra)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261106000100', 'g6a_portal_reports')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('report_kind','search',1,'بحث متقدم','Advanced search',false),
  ('report_kind','transactions',2,'تقرير المعاملات','Transactions report',false),
  ('report_kind','containers',3,'تقرير الحاويات وإرجاع الفارغ','Containers & empty return report',false),
  ('report_kind','trips',4,'تقرير رحلات النقل','Transport trips report',false),
  ('report_kind','margins',5,'الربحية (تحليلي)','Profitability (analytical)',false),
  ('report_kind','costs',6,'التكاليف (تحليلي)','Costs (analytical)',false),
  ('export_format','xlsx',1,'Excel','Excel',false),
  ('export_format','csv',2,'CSV','CSV',false),
  ('export_format','print',3,'طباعة / PDF','Print / PDF',false),
  ('search_date_field','created',1,'تاريخ الإنشاء','Created date',false),
  ('search_date_field','eta',2,'تاريخ الوصول المتوقع','ETA',false),
  ('search_date_field','declaration',3,'تاريخ البيان','Declaration date',false),
  ('search_date_field','status_changed',4,'آخر تغيير حالة','Last status change',false),
  ('portal_payment_status','unknown',1,'قيد التحديث','Updating',true),
  ('portal_payment_status','unpaid',2,'غير مسددة','Unpaid',true),
  ('portal_payment_status','partial',3,'مسددة جزئيًا','Partially paid',true),
  ('portal_payment_status','paid',4,'مسددة','Paid',true)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. helpers (revoked from PUBLIC / anon / authenticated in section 5)
-- ---------------------------------------------------------------------
-- G6a-5 management dashboard
CREATE OR REPLACE FUNCTION app.mgmt_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['admin','supervisor','branch_manager']
$$;
-- may read every export log row of the org
CREATE OR REPLACE FUNCTION app.rpt_audit_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['admin','supervisor']
$$;
-- "today" for every G6a reader (same as margin_report)
CREATE OR REPLACE FUNCTION app.rpt_today() RETURNS date LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date
$$;
CREATE OR REPLACE FUNCTION app.rpt_day(p timestamptz) RETURNS date LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p AT TIME ZONE 'Asia/Riyadh')::date
$$;
-- contains-pattern with LIKE metacharacters (\ % _) taken literally (ILIKE default escape = backslash)
CREATE OR REPLACE FUNCTION app.rpt_like(p text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p IS NULL OR p = '' THEN NULL
              ELSE '%' || replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') || '%' END
$$;
-- identifier normalization for search input (upper case, western digits, whitespace removed)
CREATE OR REPLACE FUNCTION app.rpt_norm_no(p text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.norm_code(p)
$$;
-- container numbers are stored without whitespace AND hyphens (G3 trigger, ISO "MSCU 123456-7"): normalize input the same way.
-- Declaration / B/L numbers keep their hyphens in storage, so they stay on rpt_norm_no.
CREATE OR REPLACE FUNCTION app.rpt_norm_container(p text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(upper(regexp_replace(app.to_western(coalesce(p, '')), '[[:space:]-]', '', 'g')), '')
$$;
-- start of a Riyadh calendar day as timestamptz (Asia/Riyadh has no DST). Readers compare raw columns with
-- [rpt_ts(from), rpt_ts(to + 1)) so the (org_id, <timestamp>) indexes serve the range (same rows as rpt_in(rpt_day(col))).
CREATE OR REPLACE FUNCTION app.rpt_ts(d date) RETURNS timestamptz LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN d IS NULL THEN NULL::timestamptz ELSE (d::timestamp AT TIME ZONE 'Asia/Riyadh') END
$$;
-- the caller's branch scope for a role set, computed ONCE per call (same rule as app.has_branch_role, which readers
-- used to evaluate per row): NULL = org-wide (active membership with branch_id NULL in an active org); otherwise the
-- array of active branches where the caller holds one of the roles (may be empty = no rows).
-- Use as: (v_sc IS NULL OR t.branch_id = ANY (v_sc)).
CREATE OR REPLACE FUNCTION app.rpt_scope(p_org uuid, p_roles text[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.memberships m JOIN public.organizations o ON o.id = m.org_id AND o.is_active
                  WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)
                    AND m.branch_id IS NULL)
      THEN NULL::uuid[]
    ELSE coalesce((SELECT array_agg(DISTINCT m.branch_id) FROM public.memberships m
                     JOIN public.organizations o ON o.id = m.org_id AND o.is_active
                     JOIN public.branches b ON b.id = m.branch_id AND b.is_active
                    WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.is_active AND m.role = ANY (p_roles)), '{}'::uuid[])
  END
$$;
-- an issued intent that Daftra reported cancelled / missing and the accountant has not resolved yet (G5 'issued_cancelled'
-- review item still open): the portal shows it as cancelled and the official figures leave it out (reported apart).
CREATE OR REPLACE FUNCTION app.rpt_bill_cancelled(p_intent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.billing_review_items r
                  WHERE r.intent_id = p_intent AND r.kind = 'issued_cancelled' AND r.status = 'open')
$$;
-- d within [from, to] (either bound optional); NULL d never matches
CREATE OR REPLACE FUNCTION app.rpt_in(d date, p_from date, p_to date) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT d IS NOT NULL AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)
$$;
-- one code or an array of codes of a dictionary domain → text[] (NULL when absent). MRS_INVALID <detail> otherwise.
CREATE OR REPLACE FUNCTION app.rpt_codes(f jsonb, k text, p_domain text, p_detail text DEFAULT NULL) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := f -> k; r text[]; d text := coalesce(p_detail, k);
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'string' THEN
    IF btrim(v #>> '{}') = '' THEN RETURN NULL; END IF;
    r := ARRAY[btrim(v #>> '{}')];
  ELSIF jsonb_typeof(v) = 'array' THEN
    IF jsonb_array_length(v) = 0 THEN RETURN NULL; END IF;
    IF jsonb_array_length(v) > 20 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
      PERFORM app.fail('MRS_INVALID', d);
    END IF;
    SELECT array_agg(DISTINCT btrim(e)) INTO r FROM jsonb_array_elements_text(v) e;
  ELSE
    PERFORM app.fail('MRS_INVALID', d);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(r) c WHERE NOT app.is_code(p_domain, c)) THEN PERFORM app.fail('MRS_INVALID', d); END IF;
  RETURN r;
END $$;
-- from / to (Riyadh dates) → ARRAY[from, to]; from > to or wider than p_max_days → MRS_INVALID 'date_range'
CREATE OR REPLACE FUNCTION app.rpt_range(f jsonb, p_max_days int) RETURNS date[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_from date := app.pdate(f, 'from'); v_to date := app.pdate(f, 'to');
BEGIN
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND (v_from > v_to OR v_to - v_from > p_max_days) THEN
    PERFORM app.fail('MRS_INVALID', 'date_range');
  END IF;
  RETURN ARRAY[v_from, v_to];
END $$;
-- paging
CREATE OR REPLACE FUNCTION app.rpt_limit(f jsonb, p_max int, p_default int) RETURNS int
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v numeric;
BEGIN
  IF jsonb_typeof(f -> 'limit') IN ('object','array','boolean') THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  v := app.pnum(f, 'limit', p_max);
  RETURN greatest(coalesce(round(v)::int, p_default), 1);
END $$;
CREATE OR REPLACE FUNCTION app.rpt_offset(f jsonb) RETURNS int
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(f -> 'offset') IN ('object','array','boolean') THEN PERFORM app.fail('MRS_INVALID', 'offset'); END IF;
  RETURN coalesce(round(app.pnum(f, 'offset', 1000000))::int, 0);
END $$;
-- staff of the org (clients, outsiders → MRS_FORBIDDEN 'organization')
CREATE OR REPLACE FUNCTION app.rpt_gate_staff(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'organization'); END IF;
END $$;
-- optional branch filter: must be a branch of the org (a branch outside the caller's scope just yields 0 rows)
CREATE OR REPLACE FUNCTION app.rpt_branch(p_org uuid, f jsonb) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid := app.puuid(f, 'branch_id');
BEGIN
  IF v IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v AND b.org_id = p_org) THEN
    PERFORM app.fail('MRS_INVALID', 'branch_id');
  END IF;
  RETURN v;
END $$;
-- open empty-return states
CREATE OR REPLACE FUNCTION app.rpt_open_returns() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['pending','evidence_submitted','disputed']
$$;
-- operationally open transaction states (before operationally_complete)
CREATE OR REPLACE FUNCTION app.rpt_open_tx() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['new','in_progress','customs_declaration','appointment','transport','empty_return']
$$;
-- filter keys
CREATE OR REPLACE FUNCTION app.rpt_search_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['q','declaration_no','bl_number','container_no','client_id','client_q','carrier_id','carrier_q','port',
               'date_field','from','to','branch_id','operational_status','sort','limit','offset']
$$;
CREATE OR REPLACE FUNCTION app.rpt_container_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['branch_id','client_id','container_no','date_field','from','to','return_status','operational_state','overdue',
               'sort','limit','offset']
$$;
CREATE OR REPLACE FUNCTION app.rpt_trip_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['branch_id','client_id','carrier_id','status','from','to','late','include_finance','sort','limit','offset']
$$;
-- allowed (logged) filter keys per report: the reader's keys minus limit / offset
CREATE OR REPLACE FUNCTION app.rpt_export_keys(p_report text) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT array(SELECT k FROM unnest(CASE p_report
      WHEN 'search' THEN app.rpt_search_keys()
      WHEN 'transactions' THEN app.rpt_search_keys()
      WHEN 'containers' THEN app.rpt_container_keys()
      WHEN 'trips' THEN app.rpt_trip_keys()
      WHEN 'margins' THEN ARRAY['branch_id','client_id','from','to','operational_status','level','currency']
      WHEN 'costs' THEN ARRAY['group_by','from','to','branch_id','client_id','supplier_id','service_code','level','currency','include_overhead']
      ELSE ARRAY[]::text[] END) k WHERE k NOT IN ('limit','offset'))
$$;

-- shared transaction matcher (search_records = report_transactions for the same filters).
-- Branch scope: staff role at the transaction's branch (app.rpt_scope, computed once per call — same rule as
-- has_branch_role). Parses every filter key except sort / limit / offset. Free text: ILIKE contains; identifiers
-- normalized (rpt_norm_no; container numbers rpt_norm_container); Arabic-Indic digits → western for CR / VAT / names.
-- Date ranges compare raw columns with Riyadh day bounds (sargable; the (org_id, created_at | eta | status_changed_at)
-- indexes serve them).
CREATE OR REPLACE FUNCTION app.rpt_tx_match(p_org uuid, f jsonb) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_q text; v_qp text; v_qw text; v_qn text; v_qc text; v_decl text; v_bl text; v_cno text; v_cl uuid; v_clq text; v_clw text;
  v_car uuid; v_carq text; v_port text; v_df text; v_rng date[]; v_from date; v_to date; v_tf timestamptz; v_tt timestamptz;
  v_br uuid; v_st text[]; v_sc uuid[];
BEGIN
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(v_q);
  v_qw := app.rpt_like(app.to_western(v_q));
  v_qn := app.rpt_like(app.rpt_norm_no(v_q));
  v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_decl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'declaration_no', 80)));
  v_bl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'bl_number', 80)));
  v_cno := app.rpt_like(app.rpt_norm_container(app.ptext(f, 'container_no', 80)));
  v_cl := app.puuid(f, 'client_id');
  v_clq := app.rpt_like(app.ptext(f, 'client_q', 80));
  v_clw := app.rpt_like(app.to_western(app.ptext(f, 'client_q', 80)));
  v_car := app.puuid(f, 'carrier_id');
  v_carq := app.rpt_like(app.ptext(f, 'carrier_q', 80));
  v_port := app.rpt_like(app.ptext(f, 'port', 80));
  v_df := coalesce(app.ptext(f, 'date_field', 20), 'created');
  IF v_df NOT IN ('created','eta','declaration','status_changed') THEN PERFORM app.fail('MRS_INVALID', 'date_field'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_br := app.rpt_branch(p_org, f);
  v_st := app.rpt_codes(f, 'operational_status', 'operational_status');
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  RETURN QUERY
  SELECT t.id FROM public.transactions t JOIN public.clients cl ON cl.id = t.client_id
   WHERE t.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_st IS NULL OR t.operational_status = ANY (v_st))
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_q IS NULL
          OR t.ref ILIKE v_qp OR t.ref ILIKE v_qn OR t.bl_number ILIKE v_qn OR t.declaration_no ILIKE v_qn
          OR cl.name_ar ILIKE v_qp OR cl.name_en ILIKE v_qp OR cl.name_ar ILIKE v_qw OR cl.name_en ILIKE v_qw
          OR cl.cr_number ILIKE v_qw OR cl.vat_number ILIKE v_qw
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.bl_number ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = t.id AND c.container_no ILIKE v_qc))
     AND (v_decl IS NULL OR t.declaration_no ILIKE v_decl
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no ILIKE v_decl))
     AND (v_bl IS NULL OR t.bl_number ILIKE v_bl
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.bl_number ILIKE v_bl))
     AND (v_cno IS NULL OR EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = t.id AND c.container_no ILIKE v_cno))
     AND (v_clq IS NULL OR cl.name_ar ILIKE v_clq OR cl.name_en ILIKE v_clq OR cl.name_ar ILIKE v_clw OR cl.name_en ILIKE v_clw
          OR cl.cr_number ILIKE v_clw OR cl.vat_number ILIKE v_clw)
     AND (v_car IS NULL
          OR EXISTS (SELECT 1 FROM public.transport_trips tr WHERE tr.transaction_id = t.id AND tr.carrier_id = v_car)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.shipping_agent_id = v_car))
     AND (v_carq IS NULL OR t.shipping_line ILIKE v_carq
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.carrier_name ILIKE v_carq)
          OR EXISTS (SELECT 1 FROM public.transport_trips tr JOIN public.parties pa ON pa.id = tr.carrier_id
                      WHERE tr.transaction_id = t.id AND (pa.name_ar ILIKE v_carq OR pa.name_en ILIKE v_carq)))
     AND (v_port IS NULL OR t.port_of_loading ILIKE v_port OR t.port_of_discharge ILIKE v_port
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND (b.port_of_loading ILIKE v_port OR b.port_of_discharge ILIKE v_port)))
     -- one predicate per date field (each folds away in the custom plan unless it is the chosen one)
     AND (v_df <> 'created' OR ((v_tf IS NULL OR t.created_at >= v_tf) AND (v_tt IS NULL OR t.created_at < v_tt)))
     AND (v_df <> 'status_changed' OR ((v_tf IS NULL OR t.status_changed_at >= v_tf) AND (v_tt IS NULL OR t.status_changed_at < v_tt)))
     AND (v_df <> 'eta' OR ((v_from IS NULL OR t.eta >= v_from) AND (v_to IS NULL OR t.eta <= v_to)))
     AND (v_df <> 'declaration' OR (v_from IS NULL AND v_to IS NULL)
          OR app.rpt_in(t.declaration_date, v_from, v_to)
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.status <> 'cancelled'
                       AND app.rpt_in(d.declaration_date, v_from, v_to)));
END $$;

-- which child values hit (≤ 5): container_no, declaration_no (+ status), bl_number, client, carrier, port
CREATE OR REPLACE FUNCTION app.rpt_tx_matched(p_tx uuid, f jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  t public.transactions; v_q text; v_qp text; v_qw text; v_qn text; v_qc text; v_decl text; v_bl text; v_cno text; v_clq text;
  v_clw text; v_car uuid; v_carq text; v_port text; v jsonb;
BEGIN
  SELECT * INTO t FROM public.transactions x WHERE x.id = p_tx;
  v_q := app.ptext(f, 'q', 80);
  v_qp := app.rpt_like(v_q); v_qw := app.rpt_like(app.to_western(v_q)); v_qn := app.rpt_like(app.rpt_norm_no(v_q));
  v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_decl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'declaration_no', 80)));
  v_bl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'bl_number', 80)));
  v_cno := app.rpt_like(app.rpt_norm_container(app.ptext(f, 'container_no', 80)));
  v_clq := app.rpt_like(app.ptext(f, 'client_q', 80));
  v_clw := app.rpt_like(app.to_western(app.ptext(f, 'client_q', 80)));
  v_car := app.puuid(f, 'carrier_id');
  v_carq := app.rpt_like(app.ptext(f, 'carrier_q', 80));
  v_port := app.rpt_like(app.ptext(f, 'port', 80));
  IF v_q IS NULL AND v_decl IS NULL AND v_bl IS NULL AND v_cno IS NULL AND v_clq IS NULL AND v_car IS NULL
     AND v_carq IS NULL AND v_port IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  WITH m AS (
    SELECT 1 s, 'container_no'::text field, c.container_no val, NULL::text st FROM public.containers c
     WHERE c.transaction_id = t.id AND (c.container_no ILIKE v_qc OR c.container_no ILIKE v_cno)
    UNION
    SELECT 2, 'declaration_no', d.declaration_no, d.status FROM public.customs_declarations d
     WHERE d.transaction_id = t.id AND (d.declaration_no ILIKE v_qn OR d.declaration_no ILIKE v_decl)
    UNION
    SELECT 2, 'declaration_no', t.declaration_no, NULL WHERE (t.declaration_no ILIKE v_qn OR t.declaration_no ILIKE v_decl)
       AND NOT EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no = t.declaration_no)
    UNION
    SELECT 3, 'bl_number', b.bl_number, NULL FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
     WHERE tb.transaction_id = t.id AND (b.bl_number ILIKE v_qn OR b.bl_number ILIKE v_bl)
    UNION
    SELECT 3, 'bl_number', t.bl_number, NULL WHERE (t.bl_number ILIKE v_qn OR t.bl_number ILIKE v_bl)
    UNION
    SELECT 4, 'client', cl.name_ar, NULL FROM public.clients cl
     WHERE cl.id = t.client_id
       AND (cl.name_ar ILIKE v_qp OR cl.name_en ILIKE v_qp OR cl.name_ar ILIKE v_qw OR cl.name_en ILIKE v_qw
            OR cl.cr_number ILIKE v_qw OR cl.vat_number ILIKE v_qw
            OR cl.name_ar ILIKE v_clq OR cl.name_en ILIKE v_clq OR cl.name_ar ILIKE v_clw OR cl.name_en ILIKE v_clw
            OR cl.cr_number ILIKE v_clw OR cl.vat_number ILIKE v_clw)
    UNION
    SELECT 5, 'carrier', pa.name_ar, NULL FROM public.transport_trips tr JOIN public.parties pa ON pa.id = tr.carrier_id
     WHERE tr.transaction_id = t.id AND (tr.carrier_id = v_car OR pa.name_ar ILIKE v_carq OR pa.name_en ILIKE v_carq)
    UNION
    SELECT 5, 'carrier', coalesce(b.carrier_name, pa.name_ar), NULL
      FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id LEFT JOIN public.parties pa ON pa.id = b.shipping_agent_id
     WHERE tb.transaction_id = t.id AND (b.shipping_agent_id = v_car OR b.carrier_name ILIKE v_carq)
    UNION
    SELECT 5, 'carrier', t.shipping_line, NULL WHERE t.shipping_line ILIKE v_carq
    UNION
    SELECT 6, 'port', x.p, NULL FROM (VALUES (t.port_of_loading), (t.port_of_discharge)) x(p) WHERE x.p ILIKE v_port
    UNION
    SELECT 6, 'port', x.p, NULL FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
     CROSS JOIN LATERAL (VALUES (b.port_of_loading), (b.port_of_discharge)) x(p)
     WHERE tb.transaction_id = t.id AND x.p ILIKE v_port)
  SELECT coalesce(jsonb_agg(jsonb_build_object('field', y.field, 'value', y.val)
                            || CASE WHEN y.field = 'declaration_no' THEN jsonb_build_object('declaration_status', y.st) ELSE '{}'::jsonb END
                            ORDER BY y.s, y.val), '[]'::jsonb)
    INTO v
    FROM (SELECT * FROM m WHERE m.val IS NOT NULL ORDER BY m.s, m.val LIMIT 5) y;
  RETURN v;
END $$;

-- one transaction row of search / report (finance status only with fin_read at the row's branch)
CREATE OR REPLACE FUNCTION app.rpt_tx_json(p_tx uuid, f jsonb, p_report boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', t.id, 'ref', t.ref, 'branch_id', t.branch_id, 'branch_name', b.name_ar,
           'client_id', t.client_id, 'client_name', cl.name_ar, 'client_name_en', cl.name_en,
           'operation', t.operation, 'mode', t.mode, 'operational_status', t.operational_status,
           'bl_number', t.bl_number, 'declaration_no', t.declaration_no, 'port_of_loading', t.port_of_loading,
           'port_of_discharge', t.port_of_discharge, 'shipping_line', t.shipping_line, 'eta', t.eta,
           'created_at', t.created_at, 'status_changed_at', t.status_changed_at, 'container_count', cc.n,
           'financial_status', CASE WHEN app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles()) THEN t.financial_status END,
           'matched', app.rpt_tx_matched(t.id, f))
         || CASE WHEN p_report THEN jsonb_build_object('open_returns', cc.o,
              'declaration_status', (SELECT d.status FROM public.customs_declarations d WHERE d.transaction_id = t.id
                                      ORDER BY (d.status NOT IN ('cancelled','replaced')) DESC, d.created_at DESC, d.id LIMIT 1))
            ELSE '{}'::jsonb END
    FROM public.transactions t
    JOIN public.clients cl ON cl.id = t.client_id
    JOIN public.branches b ON b.id = t.branch_id
    CROSS JOIN LATERAL (SELECT count(*)::int n, (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())))::int o
                          FROM public.containers c WHERE c.transaction_id = t.id) cc
   WHERE t.id = p_tx
$$;

-- sort key of search / report_transactions
CREATE OR REPLACE FUNCTION app.rpt_tx_sort(f jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := coalesce(app.ptext(f, 'sort', 30), 'created_desc');
BEGIN
  IF v NOT IN ('created_desc','created_asc','ref','eta','status_changed_desc') THEN PERFORM app.fail('MRS_INVALID', 'sort'); END IF;
  RETURN v;
END $$;

-- ordered page of transaction rows + total + fingerprint over the whole set
CREATE OR REPLACE FUNCTION app.rpt_tx_result(p_ids uuid[], f jsonb, p_sort text, p_limit int, p_offset int, p_report boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_items jsonb; v_total int; v_fp text;
BEGIN
  SELECT count(*)::int, md5(coalesce(string_agg(t.id::text || ':' || coalesce(t.updated_at::text, ''), ',' ORDER BY t.id), ''))
    INTO v_total, v_fp FROM public.transactions t WHERE t.id = ANY (coalesce(p_ids, '{}'::uuid[]));
  SELECT coalesce(jsonb_agg(app.rpt_tx_json(p.id, f, p_report) ORDER BY p.o), '[]'::jsonb) INTO v_items
    FROM (SELECT t.id, row_number() OVER (ORDER BY
                   CASE WHEN p_sort = 'created_desc' THEN t.created_at END DESC,
                   CASE WHEN p_sort = 'created_asc' THEN t.created_at END ASC,
                   CASE WHEN p_sort = 'ref' THEN t.ref END ASC,
                   CASE WHEN p_sort = 'eta' THEN t.eta END ASC NULLS LAST,
                   CASE WHEN p_sort = 'status_changed_desc' THEN t.status_changed_at END DESC,
                   t.id) o
            FROM public.transactions t WHERE t.id = ANY (coalesce(p_ids, '{}'::uuid[]))) p
   WHERE p.o > p_offset AND p.o <= p_offset + p_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', p_limit, 'offset', p_offset, 'fingerprint', v_fp);
END $$;

-- ---------------------------------------------------------------------
-- 2. indexes (§4.2)
-- ---------------------------------------------------------------------
-- date ranges are sargable (raw column vs Riyadh day bounds), so these serve the created / eta / status_changed filters
CREATE INDEX IF NOT EXISTS transactions_g6a_created_idx ON public.transactions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_g6a_eta_idx ON public.transactions (org_id, eta);
CREATE INDEX IF NOT EXISTS transactions_g6a_status_changed_idx ON public.transactions (org_id, status_changed_at);
-- report_trips carrier filter
CREATE INDEX IF NOT EXISTS transport_trips_g6a_carrier_idx ON public.transport_trips (org_id, carrier_id) WHERE carrier_id IS NOT NULL;
-- dash_management official figures (org, issued, issued_at range)
CREATE INDEX IF NOT EXISTS billing_intents_g6a_issued_idx ON public.billing_intents (org_id, status, issued_at);
-- dash_management completed / closed in the period (first operational_status event to that state)
CREATE INDEX IF NOT EXISTS transaction_events_g6a_status_idx ON public.transaction_events (org_id, to_status, created_at)
  WHERE event_type = 'operational_status';
-- removed after review (no G6a query can use them; every search is an ILIKE '%x%' contains match, and
-- containers_no_idx / customs_declarations_no_idx / port_appointments_open_idx already exist): a re-run on a DB that has
-- them cleans them up.
DROP INDEX IF EXISTS public.transactions_g6a_ref_idx;
DROP INDEX IF EXISTS public.containers_g6a_no_idx;
DROP INDEX IF EXISTS public.bills_of_lading_g6a_no_idx;
DROP INDEX IF EXISTS public.customs_declarations_g6a_no_idx;
DROP INDEX IF EXISTS public.port_appointments_g6a_at_idx;

-- G6a-10: trigram indexes only when pg_trgm is already installed (this file never creates the extension).
-- Only child-table columns the matcher probes directly (EXISTS sub-queries / report_containers). Trigram indexes on
-- transactions / clients columns cannot be chosen (every such predicate is OR-ed with other sources), so they are not
-- created and are dropped when an earlier run made them.
DO $trgm$
DECLARE s text; r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('transactions','ref'), ('transactions','bl_number'), ('transactions','declaration_no'),
      ('transactions','port_of_loading'), ('transactions','port_of_discharge'), ('transactions','shipping_line'),
      ('clients','name_ar'), ('clients','name_en')) AS x(tbl, col)
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.tbl || '_' || r.col || '_trgm_idx');
  END LOOP;
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  IF s IS NULL THEN
    RAISE NOTICE 'g6a: pg_trgm not installed, btree fallback';
    RETURN;
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('containers','container_no'), ('customs_declarations','declaration_no'), ('bills_of_lading','bl_number'),
      ('bills_of_lading','carrier_name'), ('parties','name_ar')) AS x(tbl, col)
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I USING gin (%I %I.gin_trgm_ops)',
                   r.tbl || '_' || r.col || '_trgm_idx', r.tbl, r.col, s);
  END LOOP;
END $trgm$;

-- ---------------------------------------------------------------------
-- 3. report_exports — append-only export audit (no row data, no totals)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor      uuid NOT NULL,
  report     text NOT NULL CHECK (report IN ('search','transactions','containers','trips','margins','costs')),
  format     text NOT NULL CHECK (format IN ('xlsx','csv','print')),
  filters    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object' AND octet_length(filters::text) <= 4096),
  row_count  int NOT NULL CHECK (row_count BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.report_exports IS 'G6a export audit: who exported which report (format, filters, row count). Never row data or totals. Append-only; written only by log_report_export.';
CREATE INDEX IF NOT EXISTS report_exports_org_idx ON public.report_exports (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS report_exports_actor_idx ON public.report_exports (actor, created_at DESC);

ALTER TABLE public.report_exports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_exports_select ON public.report_exports;
-- the auditor set is spelled out (= app.rpt_audit_roles()): G6a helpers stay revoked from the API roles, so no policy calls one
CREATE POLICY report_exports_select ON public.report_exports FOR SELECT TO authenticated
  USING ((actor = auth.uid() AND app.is_member(org_id)) OR app.has_role(org_id, ARRAY['admin','supervisor']));
REVOKE ALL ON public.report_exports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.report_exports TO authenticated;

DROP TRIGGER IF EXISTS trg_append_only ON public.report_exports;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.report_exports FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
DROP TRIGGER IF EXISTS trg_append_only_trunc ON public.report_exports;
CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON public.report_exports FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();

-- ---------------------------------------------------------------------
-- 4. RPCs
-- ---------------------------------------------------------------------

-- 4.1 search_records(p_org, {q, declaration_no, bl_number, container_no, client_id, client_q, carrier_id, carrier_q, port,
--   date_field, from, to, branch_id, operational_status, sort, limit ≤ 100 (25), offset})
CREATE OR REPLACE FUNCTION public.search_records(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_sort text; v_limit int; v_offset int; v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_search_keys());
  v_sort := app.rpt_tx_sort(f);
  v_limit := app.rpt_limit(f, 100, 25);
  v_offset := app.rpt_offset(f);
  SELECT array_agg(m) INTO v_ids FROM app.rpt_tx_match(p_org, f) m;
  RETURN app.rpt_tx_result(v_ids, f, v_sort, v_limit, v_offset, false);
END $$;

-- 5.1 report_transactions(p_org, same keys; limit ≤ 500 (100)) + open_returns, declaration_status; totals over the whole set
CREATE OR REPLACE FUNCTION public.report_transactions(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_sort text; v_limit int; v_offset int; v_ids uuid[]; v_tot jsonb; v_by jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_search_keys());
  v_sort := app.rpt_tx_sort(f);
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  SELECT array_agg(m) INTO v_ids FROM app.rpt_tx_match(p_org, f) m;
  SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_by
    FROM (SELECT t.operational_status s, count(*)::int n FROM public.transactions t
           WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[])) GROUP BY 1) x;
  SELECT jsonb_build_object('count', count(DISTINCT t.id)::int,
           'containers', coalesce(sum(cc.n), 0)::int, 'open_returns', coalesce(sum(cc.o), 0)::int, 'by_status', v_by)
    INTO v_tot
    FROM public.transactions t
    CROSS JOIN LATERAL (SELECT count(*)::int n, (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())))::int o
                          FROM public.containers c WHERE c.transaction_id = t.id) cc
   WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[]));
  RETURN app.rpt_tx_result(v_ids, f, v_sort, v_limit, v_offset, true) || jsonb_build_object('totals', v_tot);
END $$;

-- 5.1 report_containers(p_org, {branch_id, client_id, container_no, date_field (created | return_deadline | returned_at | gate_out),
--   from, to, return_status, operational_state, overdue, sort, limit ≤ 500 (100), offset})
CREATE OR REPLACE FUNCTION public.report_containers(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_cl uuid; v_cno text; v_df text; v_rng date[]; v_from date; v_to date;
  v_rs text[]; v_os text[]; v_over boolean; v_sort text; v_limit int; v_offset int; v_today date := app.rpt_today();
  v_ids uuid[]; v_total int; v_fp text; v_items jsonb; v_tot jsonb; v_by jsonb; v_tf timestamptz; v_tt timestamptz; v_sc uuid[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_container_keys());
  v_br := app.rpt_branch(p_org, f);
  v_cl := app.puuid(f, 'client_id');
  v_cno := app.rpt_like(app.rpt_norm_container(app.ptext(f, 'container_no', 80)));
  v_df := coalesce(app.ptext(f, 'date_field', 20), 'created');
  IF v_df NOT IN ('created','return_deadline','returned_at','gate_out') THEN PERFORM app.fail('MRS_INVALID', 'date_field'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_rs := app.rpt_codes(f, 'return_status', 'container_return_status');
  v_os := app.rpt_codes(f, 'operational_state', 'container_state');
  IF jsonb_typeof(f -> 'overdue') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'overdue'); END IF;
  v_over := app.pbool(f, 'overdue');
  v_sort := coalesce(app.ptext(f, 'sort', 30), 'deadline_asc');
  IF v_sort NOT IN ('deadline_asc','deadline_desc','container_no','created_desc') THEN PERFORM app.fail('MRS_INVALID', 'sort'); END IF;
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  SELECT array_agg(c.id) INTO v_ids
    FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
   WHERE t.org_id = p_org AND c.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_cno IS NULL OR c.container_no ILIKE v_cno)
     AND (v_rs IS NULL OR c.return_status = ANY (v_rs))
     AND (v_os IS NULL OR c.operational_state = ANY (v_os))
     AND (NOT v_over OR (c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline < v_today))
     AND (v_df <> 'created' OR ((v_tf IS NULL OR c.created_at >= v_tf) AND (v_tt IS NULL OR c.created_at < v_tt)))
     AND (v_df <> 'returned_at' OR ((v_tf IS NULL OR c.returned_at >= v_tf) AND (v_tt IS NULL OR c.returned_at < v_tt)))
     AND (v_df <> 'gate_out' OR ((v_tf IS NULL OR c.gate_out_at >= v_tf) AND (v_tt IS NULL OR c.gate_out_at < v_tt)))
     AND (v_df <> 'return_deadline' OR ((v_from IS NULL OR c.return_deadline >= v_from) AND (v_to IS NULL OR c.return_deadline <= v_to)));
  v_ids := coalesce(v_ids, '{}'::uuid[]);
  SELECT count(*)::int, md5(coalesce(string_agg(c.id::text || ':' || coalesce(c.updated_at::text, ''), ',' ORDER BY c.id), ''))
    INTO v_total, v_fp FROM public.containers c WHERE c.id = ANY (v_ids);
  SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_by
    FROM (SELECT c.return_status s, count(*)::int n FROM public.containers c WHERE c.id = ANY (v_ids) GROUP BY 1) x;
  SELECT jsonb_build_object('count', count(*)::int, 'by_return_status', v_by,
           'open', (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())))::int,
           'overdue', (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline < v_today))::int,
           'due_3d', (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())
                                         AND c.return_deadline BETWEEN v_today AND v_today + 3))::int)
    INTO v_tot FROM public.containers c WHERE c.id = ANY (v_ids);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'container_no', p.container_no, 'container_type', p.container_type,
           'transaction_id', p.transaction_id, 'transaction_ref', p.ref, 'client_name', p.client_name, 'branch_name', p.branch_name,
           'operational_state', p.operational_state, 'return_status', p.return_status, 'return_deadline', p.return_deadline,
           'returned_at', p.returned_at, 'gate_out_at', p.gate_out_at, 'return_location', p.return_location,
           'return_yard_name', p.yard_name,
           'days_overdue', CASE WHEN p.return_status = ANY (app.rpt_open_returns()) AND p.return_deadline < v_today
                                THEN v_today - p.return_deadline ELSE 0 END) ORDER BY p.o), '[]'::jsonb)
    INTO v_items
    FROM (SELECT c.*, t.ref, cl.name_ar client_name, b.name_ar branch_name, y.name_ar yard_name,
                 row_number() OVER (ORDER BY
                   CASE WHEN v_sort = 'deadline_asc' THEN c.return_deadline END ASC NULLS LAST,
                   CASE WHEN v_sort = 'deadline_desc' THEN c.return_deadline END DESC NULLS LAST,
                   CASE WHEN v_sort = 'container_no' THEN c.container_no END ASC,
                   CASE WHEN v_sort = 'created_desc' THEN c.created_at END DESC,
                   c.id) o
            FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
            JOIN public.clients cl ON cl.id = t.client_id JOIN public.branches b ON b.id = t.branch_id
            LEFT JOIN public.parties y ON y.id = c.return_yard_party_id
           WHERE c.id = ANY (v_ids)) p
   WHERE p.o > v_offset AND p.o <= v_offset + v_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'fingerprint', v_fp,
                            'totals', v_tot);
END $$;

-- 5.1 report_trips(p_org, {branch_id, client_id, carrier_id, status, from, to (planned_at), include_finance, sort,
--   limit ≤ 500 (100), offset}). Finance per row only with include_finance AND trip_finance at the row's branch.
CREATE OR REPLACE FUNCTION public.report_trips(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_cl uuid; v_car uuid; v_st text[]; v_rng date[]; v_from date; v_to date;
  v_fin boolean; v_sort text; v_limit int; v_offset int; v_ids uuid[]; v_total int; v_fp text; v_items jsonb; v_by jsonb;
  v_cost jsonb; v_sell jsonb; v_nfin int; v_late boolean; v_tf timestamptz; v_tt timestamptz; v_sc uuid[]; v_tsc uuid[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_trip_keys());
  v_br := app.rpt_branch(p_org, f);
  v_cl := app.puuid(f, 'client_id');
  v_car := app.puuid(f, 'carrier_id');
  v_st := app.rpt_codes(f, 'status', 'trip_status', 'trip_status');
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  -- late = planned / dispatched with planned_at already past (the dash_ops 'late' tile)
  IF jsonb_typeof(f -> 'late') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'late'); END IF;
  v_late := app.pbool(f, 'late');
  IF jsonb_typeof(f -> 'include_finance') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'include_finance'); END IF;
  v_fin := app.pbool(f, 'include_finance');
  IF v_fin AND NOT app.has_role(p_org, app.trip_finance_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'cost'); END IF;
  v_sort := coalesce(app.ptext(f, 'sort', 30), 'planned_desc');
  IF v_sort NOT IN ('planned_desc','planned_asc') THEN PERFORM app.fail('MRS_INVALID', 'sort'); END IF;
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  v_tsc := CASE WHEN v_fin THEN app.rpt_scope(p_org, app.trip_finance_roles()) ELSE '{}'::uuid[] END;
  SELECT array_agg(tr.id) INTO v_ids
    FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
   WHERE t.org_id = p_org AND tr.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_car IS NULL OR tr.carrier_id = v_car)
     AND (v_st IS NULL OR tr.status = ANY (v_st))
     AND (NOT v_late OR (tr.status IN ('planned','dispatched') AND tr.planned_at < now()))
     AND (v_tf IS NULL OR tr.planned_at >= v_tf) AND (v_tt IS NULL OR tr.planned_at < v_tt);
  v_ids := coalesce(v_ids, '{}'::uuid[]);
  SELECT count(*)::int, md5(coalesce(string_agg(tr.id::text || ':' || coalesce(tr.updated_at::text, ''), ',' ORDER BY tr.id), ''))
    INTO v_total, v_fp FROM public.transport_trips tr WHERE tr.id = ANY (v_ids);
  SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_by
    FROM (SELECT tr.status s, count(*)::int n FROM public.transport_trips tr WHERE tr.id = ANY (v_ids) GROUP BY 1) x;
  -- finance totals = Σ exactly the non-null values the rows carry
  WITH r AS (SELECT tr.* FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
              WHERE tr.id = ANY (v_ids) AND v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc)))
  SELECT (SELECT count(*)::int FROM r),
         (SELECT coalesce(jsonb_object_agg(x.c, x.s), '{}'::jsonb)
            FROM (SELECT r.cost_currency c, round(sum(r.cost_amount), 2) s FROM r WHERE r.cost_amount IS NOT NULL GROUP BY 1) x),
         (SELECT coalesce(jsonb_object_agg(x.c, x.s), '{}'::jsonb)
            FROM (SELECT r.sell_currency c, round(sum(r.sell_amount), 2) s FROM r WHERE r.sell_amount IS NOT NULL GROUP BY 1) x)
    INTO v_nfin, v_cost, v_sell;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'transaction_id', p.transaction_id, 'transaction_ref', p.ref,
           'container_no', p.container_no, 'leg_no', p.leg_no, 'carrier_name', p.carrier_name, 'driver_name', p.driver_name,
           'truck_plate', p.truck_plate, 'origin', p.origin, 'destination', p.destination, 'planned_at', p.planned_at,
           'loaded_at', p.loaded_at, 'unloaded_at', p.unloaded_at, 'status', p.status,
           'cost_amount', CASE WHEN p.fin THEN round(p.cost_amount, 2) END, 'cost_currency', CASE WHEN p.fin THEN p.cost_currency END,
           'sell_amount', CASE WHEN p.fin THEN round(p.sell_amount, 2) END, 'sell_currency', CASE WHEN p.fin THEN p.sell_currency END)
           ORDER BY p.o), '[]'::jsonb)
    INTO v_items
    FROM (SELECT tr.*, t.ref, c.container_no, pa.name_ar carrier_name, d.full_name driver_name, k.plate_no truck_plate,
                 (v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc))) fin,
                 row_number() OVER (ORDER BY
                   CASE WHEN v_sort = 'planned_desc' THEN tr.planned_at END DESC NULLS LAST,
                   CASE WHEN v_sort = 'planned_asc' THEN tr.planned_at END ASC NULLS LAST,
                   tr.id) o
            FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
            LEFT JOIN public.containers c ON c.id = tr.container_id
            LEFT JOIN public.parties pa ON pa.id = tr.carrier_id
            LEFT JOIN public.drivers d ON d.id = tr.driver_id
            LEFT JOIN public.trucks k ON k.id = tr.truck_id
           WHERE tr.id = ANY (v_ids)) p
   WHERE p.o > v_offset AND p.o <= v_offset + v_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'fingerprint', v_fp,
    'include_finance', v_fin, 'late', v_late,
    'totals', jsonb_build_object('count', v_total, 'by_status', v_by,
      'finance', jsonb_build_object('cost_by_currency', v_cost, 'sell_by_currency', v_sell, 'rows_with_finance', v_nfin)));
END $$;

-- 3.1 dash_ops(p_org, {branch_id}) — operations; no money anywhere
CREATE OR REPLACE FUNCTION public.dash_ops(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_today date := app.rpt_today(); v_tx uuid[];
  v_trx jsonb; v_app jsonb; v_trp jsonb; v_cont jsonb; v_al jsonb; v_exc int; v_req jsonb; v_sc uuid[]; v_wsc uuid[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, ARRAY['branch_id']);
  v_br := app.rpt_branch(p_org, f);
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  SELECT coalesce(array_agg(t.id), '{}'::uuid[]) INTO v_tx FROM public.transactions t
   WHERE t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br);

  SELECT jsonb_build_object(
           'by_status', coalesce((SELECT jsonb_object_agg(x.s, x.n) FROM (SELECT t.operational_status s, count(*)::int n
                                    FROM public.transactions t WHERE t.id = ANY (v_tx) GROUP BY 1) x), '{}'::jsonb),
           'open', (SELECT count(*)::int FROM public.transactions t WHERE t.id = ANY (v_tx) AND t.operational_status = ANY (app.rpt_open_tx())),
           'stale_7d', (SELECT count(*)::int FROM public.transactions t WHERE t.id = ANY (v_tx)
                          AND t.operational_status = ANY (app.rpt_open_tx()) AND t.status_changed_at < now() - interval '7 days'))
    INTO v_trx;

  SELECT jsonb_build_object(
           'today', jsonb_build_object(
              'requested', count(*) FILTER (WHERE a.status = 'requested' AND app.rpt_day(a.appointment_at) = v_today),
              'confirmed', count(*) FILTER (WHERE a.status = 'confirmed' AND app.rpt_day(a.appointment_at) = v_today),
              'completed', count(*) FILTER (WHERE a.status = 'completed' AND app.rpt_day(a.appointment_at) = v_today),
              'missed', count(*) FILTER (WHERE a.status = 'missed' AND app.rpt_day(a.appointment_at) = v_today)),
           'next_7d', count(*) FILTER (WHERE a.status IN ('requested','confirmed') AND a.appointment_at >= now()
                                         AND a.appointment_at < now() + interval '7 days'),
           'upcoming', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'transaction_id', u.transaction_id,
                                   'transaction_ref', u.ref, 'container_no', u.container_no, 'appointment_at', u.appointment_at,
                                   'status', u.status) ORDER BY u.appointment_at, u.id)
                                  FROM (SELECT a2.id, a2.transaction_id, t2.ref, c2.container_no, a2.appointment_at, a2.status
                                          FROM public.port_appointments a2 JOIN public.transactions t2 ON t2.id = a2.transaction_id
                                          LEFT JOIN public.containers c2 ON c2.id = a2.container_id
                                         WHERE a2.transaction_id = ANY (v_tx) AND a2.status IN ('requested','confirmed')
                                           AND a2.appointment_at >= now()
                                         ORDER BY a2.appointment_at, a2.id LIMIT 10) u), '[]'::jsonb))
    INTO v_app
    FROM public.port_appointments a WHERE a.transaction_id = ANY (v_tx) AND a.status NOT IN ('cancelled','rescheduled');

  SELECT jsonb_build_object(
           'by_status', jsonb_build_object('planned', count(*) FILTER (WHERE tr.status = 'planned'),
                                           'dispatched', count(*) FILTER (WHERE tr.status = 'dispatched'),
                                           'loaded', count(*) FILTER (WHERE tr.status = 'loaded'),
                                           'delivered', count(*) FILTER (WHERE tr.status = 'delivered')),
           'today_planned', count(*) FILTER (WHERE tr.status <> 'cancelled' AND app.rpt_day(tr.planned_at) = v_today),
           'late', count(*) FILTER (WHERE tr.status IN ('planned','dispatched') AND tr.planned_at < now()),
           'upcoming', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'transaction_ref', u.ref, 'container_no', u.container_no,
                                   'leg_no', u.leg_no, 'carrier_name', u.carrier_name, 'planned_at', u.planned_at, 'status', u.status)
                                   ORDER BY u.planned_at NULLS LAST, u.id)
                                  FROM (SELECT t2.id, t3.ref, c2.container_no, t2.leg_no, pa.name_ar carrier_name, t2.planned_at, t2.status
                                          FROM public.transport_trips t2 JOIN public.transactions t3 ON t3.id = t2.transaction_id
                                          LEFT JOIN public.containers c2 ON c2.id = t2.container_id
                                          LEFT JOIN public.parties pa ON pa.id = t2.carrier_id
                                         WHERE t2.transaction_id = ANY (v_tx) AND t2.status IN ('planned','dispatched')
                                         ORDER BY t2.planned_at NULLS LAST, t2.id LIMIT 10) u), '[]'::jsonb))
    INTO v_trp
    FROM public.transport_trips tr WHERE tr.transaction_id = ANY (v_tx);

  SELECT jsonb_build_object(
           'by_operational_state', coalesce((SELECT jsonb_object_agg(x.s, x.n) FROM (SELECT c2.operational_state s, count(*)::int n
                                     FROM public.containers c2 WHERE c2.transaction_id = ANY (v_tx) GROUP BY 1) x), '{}'::jsonb),
           'open_returns', count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())),
           'evidence_submitted', count(*) FILTER (WHERE c.return_status = 'evidence_submitted'),
           'disputed', count(*) FILTER (WHERE c.return_status = 'disputed'),
           'overdue', count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline < v_today),
           'due_3d', count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline BETWEEN v_today AND v_today + 3),
           'due_7d', count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline BETWEEN v_today AND v_today + 7),
           'nearest', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'container_no', u.container_no,
                                  'transaction_id', u.transaction_id, 'transaction_ref', u.ref, 'return_deadline', u.return_deadline,
                                  'return_status', u.return_status, 'days_left', u.return_deadline - v_today)
                                  ORDER BY u.return_deadline, u.id)
                                 FROM (SELECT c2.id, c2.container_no, c2.transaction_id, t2.ref, c2.return_deadline, c2.return_status
                                         FROM public.containers c2 JOIN public.transactions t2 ON t2.id = c2.transaction_id
                                        WHERE c2.transaction_id = ANY (v_tx) AND c2.return_status = ANY (app.rpt_open_returns())
                                          AND c2.return_deadline IS NOT NULL
                                        ORDER BY c2.return_deadline, c2.id LIMIT 10) u), '[]'::jsonb))
    INTO v_cont
    FROM public.containers c WHERE c.transaction_id = ANY (v_tx);

  SELECT jsonb_build_object('critical', count(*) FILTER (WHERE al.severity = 'critical'),
                            'warning', count(*) FILTER (WHERE al.severity = 'warning'),
                            'info', count(*) FILTER (WHERE al.severity = 'info'))
    INTO v_al FROM public.operational_alerts al WHERE al.transaction_id = ANY (v_tx) AND al.status IN ('open','acknowledged');
  SELECT count(*)::int INTO v_exc FROM public.operational_exceptions e
   WHERE e.transaction_id = ANY (v_tx) AND e.status IN ('open','in_progress');

  IF app.has_role(p_org, app.ops_writer_roles()) THEN
    -- a request without a branch: any ops writer of the org (checked above); with a branch: ops writer there
    v_wsc := app.rpt_scope(p_org, app.ops_writer_roles());
    SELECT jsonb_build_object('new', count(*) FILTER (WHERE r.status = 'new'), 'under_review', count(*) FILTER (WHERE r.status = 'under_review'))
      INTO v_req FROM public.service_requests r
     WHERE r.org_id = p_org AND r.status IN ('new','under_review')
       AND (r.branch_id IS NULL OR v_wsc IS NULL OR r.branch_id = ANY (v_wsc))
       AND (v_br IS NULL OR r.branch_id = v_br);
  END IF;

  RETURN jsonb_build_object('transactions', v_trx, 'appointments', v_app, 'transport', v_trp, 'containers', v_cont,
    'alerts', v_al, 'exceptions_open', v_exc, 'requests', v_req, 'branch_id', v_br, 'generated_at', now());
END $$;

-- 3.2 dash_finance(p_org, {branch_id, currency}) — official figures = Daftra-synced fields of issued intents only
CREATE OR REPLACE FUNCTION public.dash_finance(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_cur text; v_today date := app.rpt_today(); v_tx uuid[];
  v_si jsonb; v_pay jsonb; v_due7 int; v_costs jsonb; v_bill jsonb; v_off jsonb; v_last timestamptz; v_unoff jsonb; v_fs jsonb;
  v_conn jsonb; v_rq int; v_fsc uuid[]; v_canc jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['branch_id','currency']);
  v_br := app.rpt_branch(p_org, f);
  v_cur := app.fin_currency(f, 'currency');
  v_fsc := app.rpt_scope(p_org, app.fin_read_roles());
  SELECT coalesce(array_agg(t.id), '{}'::uuid[]) INTO v_tx FROM public.transactions t
   WHERE t.org_id = p_org AND (v_fsc IS NULL OR t.branch_id = ANY (v_fsc)) AND (v_br IS NULL OR t.branch_id = v_br);

  -- supplier invoices: scope = their own (receiving) branch
  SELECT jsonb_build_object(
           'by_status', jsonb_build_object('received', count(*) FILTER (WHERE si.status = 'received'),
                                           'under_review', count(*) FILTER (WHERE si.status = 'under_review'),
                                           'approved', count(*) FILTER (WHERE si.status = 'approved'),
                                           'disputed', count(*) FILTER (WHERE si.status = 'disputed')),
           'needs_review', count(*) FILTER (WHERE si.status IN ('received','under_review')))
    INTO v_si FROM public.supplier_invoices si
   WHERE si.org_id = p_org AND (v_fsc IS NULL OR si.branch_id = ANY (v_fsc))
     AND (v_br IS NULL OR si.branch_id = v_br) AND (v_cur IS NULL OR si.currency = v_cur);
  WITH o AS (
    -- owed = G4 payable (total − approved credit notes against it) − paid, same as G4 due_approved_unpaid
    SELECT si.currency cur, greatest(app.fin_invoice_payable(si.id) - si.company_paid_amount - si.client_paid_amount, 0) amt, si.due_date
      FROM public.supplier_invoices si
     WHERE si.org_id = p_org AND si.status = 'approved' AND si.doc_type <> 'credit_note' AND si.payment_status IN ('unpaid','partial')
       AND (v_fsc IS NULL OR si.branch_id = ANY (v_fsc))
       AND (v_br IS NULL OR si.branch_id = v_br) AND (v_cur IS NULL OR si.currency = v_cur))
  SELECT coalesce((SELECT jsonb_object_agg(x.cur, jsonb_build_object('open_amount', x.oa, 'overdue_amount', x.ova,
                     'open_count', x.oc, 'overdue_count', x.ovc))
                     FROM (SELECT o.cur, round(sum(o.amt), 2) oa, round(coalesce(sum(o.amt) FILTER (WHERE o.due_date < v_today), 0), 2) ova,
                                  count(*)::int oc, (count(*) FILTER (WHERE o.due_date < v_today))::int ovc
                             FROM o GROUP BY o.cur) x), '{}'::jsonb),
         (SELECT count(*)::int FROM o WHERE o.due_date BETWEEN v_today AND v_today + 7)
    INTO v_pay, v_due7;

  -- G4 queues (uncapped counts, same predicates as cost_review_queue / list_accruals / list_cost_adjustments)
  SELECT
    (SELECT count(*)::int FROM public.supplier_invoice_lines l JOIN public.supplier_invoices si ON si.id = l.supplier_invoice_id
      WHERE si.org_id = p_org AND si.status <> 'void' AND l.review_status IN ('pending_review','disputed')
        AND (v_fsc IS NULL OR si.branch_id = ANY (v_fsc)) AND (v_br IS NULL OR si.branch_id = v_br))
    + (SELECT count(*)::int FROM public.supplier_invoices si
        JOIN LATERAL (SELECT count(*) n, coalesce(sum(l.net_amount), 0) net, coalesce(sum(l.vat_amount), 0) vat,
                             coalesce(sum(l.total_amount), 0) tot
                        FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id) ls ON true
       WHERE si.org_id = p_org AND si.status IN ('received','under_review','disputed')
         AND (v_fsc IS NULL OR si.branch_id = ANY (v_fsc)) AND (v_br IS NULL OR si.branch_id = v_br)
         AND ls.n > 0 AND (si.subtotal <> ls.net OR si.vat_amount <> ls.vat OR si.total_amount <> ls.tot))
    + (SELECT count(*)::int FROM public.cost_allocations a WHERE a.org_id = p_org AND a.status = 'proposed' AND a.transaction_id = ANY (v_tx))
    + (SELECT count(*)::int FROM public.cost_accruals ac WHERE ac.org_id = p_org AND ac.status = 'variance' AND ac.transaction_id = ANY (v_tx))
    + (SELECT count(*)::int FROM public.cost_adjustments j LEFT JOIN public.transactions t ON t.id = j.transaction_id
        LEFT JOIN public.supplier_invoices si ON si.id = j.supplier_invoice_id
       WHERE j.org_id = p_org AND j.status = 'proposed' AND app.fin_can_read_adjustment(j.transaction_id, j.supplier_invoice_id)
         AND (v_br IS NULL OR coalesce(t.branch_id, si.branch_id) = v_br))
    INTO v_rq;
  SELECT jsonb_build_object('review_queue', v_rq,
    'accruals_open', (SELECT count(*)::int FROM public.cost_accruals ac WHERE ac.org_id = p_org AND ac.status = 'open'
                        AND ac.transaction_id = ANY (v_tx) AND (v_cur IS NULL OR ac.currency = v_cur)),
    'adjustments_pending', (SELECT count(*)::int FROM public.cost_adjustments j LEFT JOIN public.transactions t ON t.id = j.transaction_id
                              LEFT JOIN public.supplier_invoices si ON si.id = j.supplier_invoice_id
                             WHERE j.org_id = p_org AND j.status = 'proposed'
                               AND app.fin_can_read_adjustment(j.transaction_id, j.supplier_invoice_id)
                               AND (v_br IS NULL OR coalesce(t.branch_id, si.branch_id) = v_br)
                               AND (v_cur IS NULL OR j.currency = v_cur)))
    INTO v_costs;

  -- billing (G5): intents by parent transaction's branch
  SELECT jsonb_build_object(
           'intents_by_status', jsonb_build_object('open', count(*) FILTER (WHERE i.status = 'open'),
                                                   'draft', count(*) FILTER (WHERE i.status = 'draft'),
                                                   'issued', count(*) FILTER (WHERE i.status = 'issued')),
           'sync', jsonb_build_object('pending', count(*) FILTER (WHERE i.sync_state = 'pending'),
                                      'in_flight', count(*) FILTER (WHERE i.sync_state = 'in_flight'),
                                      'unknown', count(*) FILTER (WHERE i.sync_state = 'unknown'),
                                      'conflict', count(*) FILTER (WHERE i.sync_state = 'conflict'),
                                      'error', count(*) FILTER (WHERE i.sync_state = 'error')))
    INTO v_bill FROM public.billing_intents i
   WHERE i.org_id = p_org AND i.transaction_id = ANY (v_tx) AND i.status <> 'cancelled' AND (v_cur IS NULL OR i.currency = v_cur);
  SELECT CASE WHEN c.id IS NULL THEN jsonb_build_object('status', 'not_connected', 'mode', 'mock', 'sync_enabled', false)
              ELSE jsonb_build_object('status', c.status, 'mode', c.mode, 'sync_enabled', c.sync_enabled) END
    INTO v_conn FROM (SELECT 1) one LEFT JOIN public.daftra_connections c ON c.org_id = p_org;
  v_bill := v_bill || jsonb_build_object(
    'jobs', (SELECT jsonb_build_object('queued', count(*) FILTER (WHERE j.status = 'queued'),
                                       'failed', count(*) FILTER (WHERE j.status = 'failed'),
                                       'dead', count(*) FILTER (WHERE j.status = 'dead'))
               FROM public.billing_sync_jobs j LEFT JOIN public.billing_intents i ON i.id = j.intent_id
              WHERE j.org_id = p_org AND j.status IN ('queued','failed','dead') AND app.bill_can_read_job(j)
                AND (CASE WHEN j.intent_id IS NULL THEN v_br IS NULL AND v_cur IS NULL
                          ELSE i.transaction_id = ANY (v_tx) AND (v_cur IS NULL OR i.currency = v_cur) END)),
    'review_open', (SELECT count(*)::int FROM public.billing_review_items r
                     WHERE r.org_id = p_org AND r.status = 'open' AND r.transaction_id = ANY (v_tx)),
    'connection', v_conn);

  -- official = Daftra-synced columns of ISSUED intents only (G6a-6), minus those Daftra reported cancelled while the
  -- G5 'issued_cancelled' review item is still open (the portal shows them as cancelled); those are reported apart.
  SELECT coalesce(jsonb_object_agg(x.cur, jsonb_build_object('issued_count', x.n, 'total', x.tot, 'paid', x.paid,
                    'outstanding', x.tot - x.paid)), '{}'::jsonb)
    INTO v_off
    FROM (SELECT i.currency::text cur, count(*)::int n, round(coalesce(sum(i.remote_total), 0), 2) tot,
                 round(coalesce(sum(coalesce(i.paid_amount, 0)), 0), 2) paid
            FROM public.billing_intents i
           WHERE i.org_id = p_org AND i.status = 'issued' AND i.transaction_id = ANY (v_tx) AND (v_cur IS NULL OR i.currency = v_cur)
             AND NOT app.rpt_bill_cancelled(i.id)
           GROUP BY 1) x;
  SELECT max(i.last_synced_at) INTO v_last FROM public.billing_intents i
   WHERE i.org_id = p_org AND i.status = 'issued' AND i.transaction_id = ANY (v_tx) AND (v_cur IS NULL OR i.currency = v_cur)
     AND NOT app.rpt_bill_cancelled(i.id);
  SELECT coalesce(jsonb_object_agg(x.cur, jsonb_build_object('count', x.n, 'total', x.tot)), '{}'::jsonb)
    INTO v_canc
    FROM (SELECT i.currency::text cur, count(*)::int n, round(coalesce(sum(i.remote_total), 0), 2) tot
            FROM public.billing_intents i
           WHERE i.org_id = p_org AND i.status = 'issued' AND i.transaction_id = ANY (v_tx) AND (v_cur IS NULL OR i.currency = v_cur)
             AND app.rpt_bill_cancelled(i.id)
           GROUP BY 1) x;
  -- unofficial = Marsa line totals of open / draft intents (never added to official)
  SELECT jsonb_build_object('open_intents', coalesce(sum(x.n), 0)::int,
           'open_lines_total_by_currency', coalesce(jsonb_object_agg(x.cur, x.tot), '{}'::jsonb),
           'label_ar', 'قيد الإعداد — غير رسمي', 'label_en', 'In preparation — not official')
    INTO v_unoff
    FROM (SELECT i.currency::text cur, count(*)::int n, round(sum(i.lines_total), 2) tot
            FROM public.billing_intents i
           WHERE i.org_id = p_org AND i.status IN ('open','draft') AND i.transaction_id = ANY (v_tx) AND (v_cur IS NULL OR i.currency = v_cur)
           GROUP BY 1) x;
  SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_fs
    FROM (SELECT t.financial_status s, count(*)::int n FROM public.transactions t WHERE t.id = ANY (v_tx) GROUP BY 1) x;

  RETURN jsonb_build_object('supplier_invoices', v_si, 'payables', jsonb_build_object('by_currency', v_pay, 'due_7d_count', v_due7),
    'costs', v_costs, 'billing', v_bill,
    'official', jsonb_build_object('by_currency', v_off, 'source', 'daftra', 'last_synced_at', v_last,
                                   'cancelled_pending_review', jsonb_build_object('by_currency', v_canc)),
    'unofficial', v_unoff, 'financial_status', v_fs, 'branch_id', v_br, 'currency', v_cur, 'generated_at', now());
END $$;

-- (G6a build had app.rpt_mgmt_rows, a full-history scan with per-row event look-ups; replaced by period-bounded queries)
DROP FUNCTION IF EXISTS app.rpt_mgmt_rows(uuid, uuid);

-- 3.3 dash_management(p_org, {branch_id, from, to}) — default: current month (Riyadh); one bound alone → the other
-- defaults to that bound's month. Every period figure is read from period-bounded rows (created_at / first status
-- event / returned_at / issued_at in [from, to + 1) Riyadh); the "now" figures from their selective side.
CREATE OR REPLACE FUNCTION public.dash_management(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_rng date[]; v_from date; v_to date; v_today date := app.rpt_today();
  v_tf timestamptz; v_tt timestamptz; v_sc uuid[]; v_fsc uuid[];
  v_req jsonb; v_trx jsonb; v_cont jsonb; v_alc int; v_by jsonb; v_fin jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  IF NOT app.has_role(p_org, app.mgmt_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(f, ARRAY['branch_id','from','to']);
  v_br := app.rpt_branch(p_org, f);
  v_rng := app.rpt_range(f, 1096);
  v_from := coalesce(v_rng[1], CASE WHEN v_rng[2] IS NOT NULL THEN date_trunc('month', v_rng[2])::date
                                    ELSE date_trunc('month', v_today)::date END);
  v_to := coalesce(v_rng[2], CASE WHEN v_rng[1] IS NOT NULL THEN (date_trunc('month', v_rng[1]) + interval '1 month - 1 day')::date
                                  ELSE (date_trunc('month', v_today) + interval '1 month - 1 day')::date END);
  IF v_from > v_to OR v_to - v_from > 1096 THEN PERFORM app.fail('MRS_INVALID', 'date_range'); END IF;
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_sc := app.rpt_scope(p_org, app.mgmt_roles());
  v_fsc := app.rpt_scope(p_org, app.fin_read_roles());

  SELECT jsonb_build_object('received', count(*), 'converted', count(*) FILTER (WHERE r.status = 'converted'),
                            'rejected', count(*) FILTER (WHERE r.status = 'rejected'))
    INTO v_req FROM public.service_requests r
   WHERE r.org_id = p_org AND r.created_at >= v_tf AND r.created_at < v_tt
     -- no branch: any mgmt role of the org (gate above); with a branch: mgmt role there
     AND (r.branch_id IS NULL OR v_sc IS NULL OR r.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR r.branch_id = v_br);

  WITH
  cr AS (SELECT t.branch_id FROM public.transactions t
          WHERE t.org_id = p_org AND t.created_at >= v_tf AND t.created_at < v_tt
            AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)),
  op AS (SELECT t.branch_id FROM public.transactions t
          WHERE t.org_id = p_org AND t.operational_status = ANY (app.rpt_open_tx())
            AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)),
  -- first operational_status event to operationally_complete / closed of each transaction, when it falls in the period
  ev AS (SELECT e.to_status st, t.branch_id, t.created_at tx_created, e.created_at at
           FROM public.transaction_events e JOIN public.transactions t ON t.id = e.transaction_id
          WHERE e.org_id = p_org AND e.event_type = 'operational_status' AND e.to_status IN ('operationally_complete','closed')
            AND e.created_at >= v_tf AND e.created_at < v_tt
            AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)
            AND NOT EXISTS (SELECT 1 FROM public.transaction_events e2
                             WHERE e2.transaction_id = e.transaction_id AND e2.event_type = 'operational_status'
                               AND e2.to_status = e.to_status
                               AND (e2.created_at < e.created_at OR (e2.created_at = e.created_at AND e2.id < e.id)))),
  od AS (SELECT t.branch_id FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
          WHERE c.org_id = p_org AND c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline < v_today
            AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br))
  SELECT jsonb_build_object(
           'created', (SELECT count(*) FROM cr),
           'completed', (SELECT count(*) FROM ev WHERE ev.st = 'operationally_complete'),
           'closed', (SELECT count(*) FROM ev WHERE ev.st = 'closed'),
           'open_now', (SELECT count(*) FROM op),
           'avg_cycle_days', (SELECT round((avg(extract(epoch FROM (ev.at - ev.tx_created)) / 86400.0))::numeric, 1)
                                FROM ev WHERE ev.st = 'operationally_complete')),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name_ar, 'branch_name_en', b.name_en,
                   'open_now', (SELECT count(*)::int FROM op WHERE op.branch_id = b.id),
                   'created', (SELECT count(*)::int FROM cr WHERE cr.branch_id = b.id),
                   'completed', (SELECT count(*)::int FROM ev WHERE ev.branch_id = b.id AND ev.st = 'operationally_complete'),
                   'overdue_now', (SELECT count(*)::int FROM od WHERE od.branch_id = b.id))
                   ORDER BY b.code, b.id), '[]'::jsonb)
            FROM public.branches b
           WHERE b.org_id = p_org AND (v_sc IS NULL OR b.id = ANY (v_sc)) AND (v_br IS NULL OR b.id = v_br)),
         jsonb_build_object('overdue_now', (SELECT count(*) FROM od),
           'returned_in_period', (SELECT count(*) FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
                                   WHERE c.org_id = p_org AND c.returned_at >= v_tf AND c.returned_at < v_tt
                                     AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
                                     AND (v_br IS NULL OR t.branch_id = v_br)))
    INTO v_trx, v_by, v_cont;

  SELECT count(*)::int INTO v_alc FROM public.operational_alerts al JOIN public.transactions t ON t.id = al.transaction_id
   WHERE al.org_id = p_org AND al.status IN ('open','acknowledged') AND al.severity = 'critical'
     AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br);

  -- finance block only from rows where the caller ALSO has fin_read (G6a-6: official = Daftra-synced, issued only;
  -- an issued invoice Daftra reported cancelled, with the G5 review item still open, is reported apart)
  IF app.has_role(p_org, app.fin_read_roles()) THEN
    WITH bi AS (SELECT i.id, i.currency::text cur, i.remote_total, i.paid_amount, app.rpt_bill_cancelled(i.id) canc
                  FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id
                 WHERE i.org_id = p_org AND i.status = 'issued' AND i.issued_at >= v_tf AND i.issued_at < v_tt
                   AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_fsc IS NULL OR t.branch_id = ANY (v_fsc))
                   AND (v_br IS NULL OR t.branch_id = v_br))
    SELECT jsonb_build_object(
      'official_by_currency', coalesce((SELECT jsonb_object_agg(x.cur, jsonb_build_object('issued_count', x.n, 'total', x.tot, 'paid', x.paid))
          FROM (SELECT bi.cur, count(*)::int n, round(coalesce(sum(bi.remote_total), 0), 2) tot,
                       round(coalesce(sum(coalesce(bi.paid_amount, 0)), 0), 2) paid
                  FROM bi WHERE NOT bi.canc GROUP BY 1) x), '{}'::jsonb),
      'cancelled_pending_review_by_currency', coalesce((SELECT jsonb_object_agg(x.cur, jsonb_build_object('count', x.n, 'total', x.tot))
          FROM (SELECT bi.cur, count(*)::int n, round(coalesce(sum(bi.remote_total), 0), 2) tot
                  FROM bi WHERE bi.canc GROUP BY 1) x), '{}'::jsonb),
      'payables_overdue_by_currency', coalesce((SELECT jsonb_object_agg(x.cur, x.amt)
          FROM (SELECT si.currency::text cur,
                       round(sum(greatest(app.fin_invoice_payable(si.id) - si.company_paid_amount - si.client_paid_amount, 0)), 2) amt
                  FROM public.supplier_invoices si
                 WHERE si.org_id = p_org AND si.status = 'approved' AND si.doc_type <> 'credit_note'
                   AND si.payment_status IN ('unpaid','partial') AND si.due_date < v_today
                   AND (v_fsc IS NULL OR si.branch_id = ANY (v_fsc))
                   AND (v_sc IS NULL OR si.branch_id = ANY (v_sc))
                   AND (v_br IS NULL OR si.branch_id = v_br)
                 GROUP BY 1) x), '{}'::jsonb),
      'margin_link', '#margins', 'source', 'daftra')
      INTO v_fin;
  END IF;

  RETURN jsonb_build_object('period', jsonb_build_object('from', v_from, 'to', v_to), 'requests', v_req, 'transactions', v_trx,
    'containers', v_cont, 'alerts_critical_now', v_alc, 'by_branch', v_by, 'finance', v_fin, 'branch_id', v_br,
    'generated_at', now());
END $$;

-- 2.2 portal_invoices(p_tx?) — ISSUED Daftra invoices billed to the caller's own client (Daftra-synced fields only).
-- Ownership is the invoice's own bill-to client (billing_intents.client_id, frozen by G5), not the transaction's current
-- client_id: a transaction moved to another client after issue never hands the old client's tax invoice to the new one.
CREATE OR REPLACE FUNCTION public.portal_invoices(p_tx uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_items jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = p_tx AND t.client_id IN (SELECT app.my_client_ids()))
     AND NOT EXISTS (SELECT 1 FROM public.billing_intents i WHERE i.transaction_id = p_tx AND i.status = 'issued'
                        AND i.client_id IN (SELECT app.my_client_ids())) THEN
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
           WHERE i.status = 'issued' AND i.client_id IN (SELECT app.my_client_ids())
             AND (p_tx IS NULL OR i.transaction_id = p_tx)
           ORDER BY i.issued_at DESC NULLS LAST, i.id LIMIT 200) x;
  RETURN jsonb_build_object('items', v_items, 'count', jsonb_array_length(v_items));
END $$;

-- 5.4 log_report_export(p_org, {report, format, filters?, row_count}) → {id, created_at}. Same gate as the report.
CREATE OR REPLACE FUNCTION public.log_report_export(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_report text; v_format text; v_f jsonb; v_rows numeric; k text; v jsonb;
  v_id uuid; v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['report','format','filters','row_count']);
  IF jsonb_typeof(p -> 'report') IS DISTINCT FROM 'string' OR NOT app.is_code('report_kind', p ->> 'report') THEN
    PERFORM app.fail('MRS_INVALID', 'report');
  END IF;
  IF jsonb_typeof(p -> 'format') IS DISTINCT FROM 'string' OR NOT app.is_code('export_format', p ->> 'format') THEN
    PERFORM app.fail('MRS_INVALID', 'format');
  END IF;
  v_report := p ->> 'report'; v_format := p ->> 'format';
  v_f := coalesce(nullif(p -> 'filters', 'null'::jsonb), '{}'::jsonb);
  -- the report's own gate
  PERFORM app.rpt_gate_staff(p_org);
  IF v_report IN ('margins','costs') THEN PERFORM app.fin_org_read(p_org); END IF;
  IF jsonb_typeof(v_f) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'filters'); END IF;
  IF v_report = 'trips' AND lower(coalesce(v_f ->> 'include_finance', '')) IN ('true','1','on','yes')
     AND NOT app.has_role(p_org, app.trip_finance_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'cost');
  END IF;
  -- filters: keys of the report, scalar values / arrays of codes, text ≤ 80
  IF octet_length(v_f::text) > 4096 THEN PERFORM app.fail('MRS_TOO_LONG', 'filters'); END IF;
  FOR k, v IN SELECT * FROM jsonb_each(v_f) LOOP
    IF NOT (k = ANY (app.rpt_export_keys(v_report))) THEN PERFORM app.fail('MRS_INVALID', 'filters'); END IF;
    IF jsonb_typeof(v) = 'object' THEN PERFORM app.fail('MRS_INVALID', 'filters'); END IF;
    IF jsonb_typeof(v) = 'string' AND char_length(v #>> '{}') > 80 THEN PERFORM app.fail('MRS_TOO_LONG', 'filters'); END IF;
    IF jsonb_typeof(v) = 'array' THEN
      IF jsonb_array_length(v) > 20 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
        PERFORM app.fail('MRS_INVALID', 'filters');
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v) e WHERE char_length(e) > 80) THEN PERFORM app.fail('MRS_TOO_LONG', 'filters'); END IF;
    END IF;
  END LOOP;
  -- row count (G6a-8 caps)
  IF jsonb_typeof(p -> 'row_count') IS DISTINCT FROM 'number' THEN PERFORM app.fail('MRS_INVALID', 'export_rows'); END IF;
  v_rows := (p ->> 'row_count')::numeric;
  IF v_rows <> trunc(v_rows) OR v_rows < 0 OR v_rows > 10000 OR (v_format = 'print' AND v_rows > 2000) THEN
    PERFORM app.fail('MRS_INVALID', 'export_rows');
  END IF;
  INSERT INTO public.report_exports (org_id, actor, report, format, filters, row_count)
  VALUES (p_org, auth.uid(), v_report, v_format, v_f, v_rows::int)
  RETURNING id, created_at INTO v_id, v_at;
  RETURN jsonb_build_object('id', v_id, 'created_at', v_at);
END $$;

-- 5.4 list_report_exports(p_org, {actor, report, from, to, limit ≤ 200 (50), offset}) — auditors: all rows; others: own rows
CREATE OR REPLACE FUNCTION public.list_report_exports(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_actor uuid; v_report text; v_rng date[]; v_from date; v_to date; v_limit int;
  v_offset int; v_all boolean; v_items jsonb; v_total int; v_tf timestamptz; v_tt timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, ARRAY['actor','report','from','to','limit','offset']);
  v_actor := app.puuid(f, 'actor');
  v_report := app.ptext(f, 'report', 20);
  IF v_report IS NOT NULL AND NOT app.is_code('report_kind', v_report) THEN PERFORM app.fail('MRS_INVALID', 'report'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_limit := app.rpt_limit(f, 200, 50);
  v_offset := app.rpt_offset(f);
  v_all := app.has_role(p_org, app.rpt_audit_roles());
  WITH s AS (
    SELECT x.*, pr.full_name actor_name FROM public.report_exports x LEFT JOIN public.profiles pr ON pr.id = x.actor
     WHERE x.org_id = p_org AND (v_all OR x.actor = auth.uid())
       AND (v_actor IS NULL OR x.actor = v_actor) AND (v_report IS NULL OR x.report = v_report)
       AND (v_tf IS NULL OR x.created_at >= v_tf) AND (v_tt IS NULL OR x.created_at < v_tt))
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'actor', p.actor, 'actor_name', p.actor_name, 'report', p.report,
                    'format', p.format, 'filters', p.filters, 'row_count', p.row_count, 'created_at', p.created_at)
                    ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
            FROM (SELECT * FROM s ORDER BY s.created_at DESC, s.id LIMIT v_limit OFFSET v_offset) p),
         (SELECT count(*)::int FROM s)
    INTO v_items, v_total;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'all', v_all);
END $$;

-- ---------------------------------------------------------------------
-- 5. privileges
-- ---------------------------------------------------------------------
-- every G6a app.* helper: revoked from everyone (the SECURITY DEFINER RPCs run them as owner; no policy uses them)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND (p.proname LIKE 'rpt\_%' OR p.proname IN ('mgmt_roles')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION
  public.search_records(uuid, jsonb), public.report_transactions(uuid, jsonb), public.report_containers(uuid, jsonb),
  public.report_trips(uuid, jsonb), public.dash_ops(uuid, jsonb), public.dash_finance(uuid, jsonb),
  public.dash_management(uuid, jsonb), public.portal_invoices(uuid), public.log_report_export(uuid, jsonb),
  public.list_report_exports(uuid, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.search_records(uuid, jsonb), public.report_transactions(uuid, jsonb), public.report_containers(uuid, jsonb),
  public.report_trips(uuid, jsonb), public.dash_ops(uuid, jsonb), public.dash_finance(uuid, jsonb),
  public.dash_management(uuid, jsonb), public.portal_invoices(uuid), public.log_report_export(uuid, jsonb),
  public.list_report_exports(uuid, jsonb)
TO authenticated;
