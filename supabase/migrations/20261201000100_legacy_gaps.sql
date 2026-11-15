-- =====================================================================
-- 20261201000100_legacy_gaps — the legacy gaps of the staff screens (2026-11-16)
--   1. public.match_client (20261117000100 body, re-created): + the Daftra client code — exact (strong, reason daftra_code) or
--      prefix (weak, reason daftra_code_prefix), given as daftra_client_code or typed into the name field as one code-shaped
--      token; + a word-prefix match of the typed name (weak, reason name_prefix; ≥ 2 characters) so the new-transaction
--      typeahead answers from 2 letters; rows + daftra_client_code, port_category. Same gate (staff of the org), same
--      20-row limit, never links.
--   2. public.set_client_legacy_fields(p_client, {port_category?, daftra_client_code?}) — the client category (airport / port /
--      shared, the clients_port_category_chk values) and the Daftra client code (trimmed, unique per org case-insensitively
--      like clients_daftra_code_uidx → MRS_INVALID daftra_client_code_taken) set from the #clients edit dialog by the roles
--      that may edit a client (clients_update: ops writers of the org). The row update leaves the app.tg_audit row of any
--      client edit. public.staff_internal_fields (20261117000100 body, re-created): clients + daftra_client_code,
--      port_category (the code is not in the clients column grant: staff read it here, portal users never).
--   3. follow-up employee = transactions.responsible_user_id (0200 column, already read by the reports as the employee):
--      app.tg_transactions_responsible + trigger trg_responsible (BEFORE INSERT OR UPDATE OF responsible_user_id) — a new /
--      changed value must be an active staff member of the transaction's org, org-wide or of the transaction's (active)
--      branch (MRS_INVALID responsible_user_id); who may set it = who may insert / update the transaction (RLS
--      transactions_insert / transactions_update). An unchanged value is never re-checked (a member deactivated later stays
--      on his transactions).
--      public.list_assignable_staff(p_org, p_branch?) → {rows [{user_id, full_name}]} — the selectable employees (active
--      staff memberships; with p_branch: org-wide members + that branch's members); ops writers only (of p_branch when given).
--   4. container seal no. / size-type at creation: no SQL change — public.containers already takes seal_no (≤ 30) and
--      size_type (≤ 10) on the insert the new-transaction form makes, normalised by app.tg_containers_g3_before like the
--      detail page's container edit.
--   5. public.custody_balances (20261122000100 body, re-created): rows + client_code (the Daftra client code); q also matches
--      the code (prefix, punctuation-insensitive); + org totals total_deposits / total_deductions / total_refunds /
--      client_count over the same rows as total_balance.
--   6. public.report_trips (20261124000100 body, re-created): party_type accepts 'unset' (trips with no party type and no
--      carrier) beside the transport_party_type codes (app.rpt_party_types); the filter and rows[].party_type use the effective
--      type (a carrier alone = 'company', as totals.by_carrier groups it); rows + declaration_no, tx_transport_order_no /
--      tx_transport_order_date (the transaction's TASTO order), client_id; totals + transport_value (= the cost by currency
--      the rows carry, finance only — the same figure as totals.finance.cost_by_currency).
--   7. report_transactions: unchanged (totals.by_daftra_state {none|draft|issued|cancelled_review: count} for finance readers,
--      null otherwise).
--   Re-runnable (CREATE OR REPLACE / DROP TRIGGER IF EXISTS + CREATE / ON CONFLICT); changes no data.
--   Down-path: DROP TRIGGER trg_responsible ON public.transactions; DROP FUNCTION app.tg_transactions_responsible(),
--   public.set_client_legacy_fields(uuid, jsonb), public.list_assignable_staff(uuid, uuid), app.rpt_party_types(jsonb);
--   re-create public.match_client and public.staff_internal_fields from 20261117000100, public.custody_balances from
--   20261122000100 and public.report_trips from 20261124000100 (their bodies, verbatim); DELETE FROM public.schema_versions
--   WHERE version = '20261201000100'. Codes / categories set in the meantime are kept.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261130000100') THEN
    RAISE EXCEPTION 'LEGACY GAPS preflight: apply tx_container_count first (schema_versions lacks 20261130000100)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'daftra_client_code')
     OR to_regprocedure('public.custody_balances(uuid,jsonb)') IS NULL OR to_regprocedure('public.report_trips(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'LEGACY GAPS preflight: legacy_daftra (20261123000100) / legacy_pay / legacy_reports missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261201000100', 'legacy_gaps')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. match_client (20261117000100 body; GAPS: the Daftra client code, the word-prefix name match, + code / category on rows)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_client(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text; v_name_en text; v_vat text; v_cr text;
  v_out jsonb; v_conflict boolean;
  v_code text; v_raw text;                                                                                          -- GAPS
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_name := app.norm_name(app.ptext(p_payload, 'name', 160));
  v_name_en := app.norm_name(app.ptext(p_payload, 'name_en', 160));
  v_vat := app.digits(app.ptext(p_payload, 'vat_number', 30));
  v_cr := app.digits(app.ptext(p_payload, 'cr_number', 30));
  -- GAPS: the Daftra client code (clients_daftra_code_chk shape), given or typed into the name field as one token
  v_code := app.to_western(app.ptext(p_payload, 'daftra_client_code', 40));
  IF v_code IS NOT NULL AND v_code !~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$' THEN PERFORM app.fail('MRS_INVALID', 'daftra_client_code'); END IF;
  IF v_code IS NULL THEN
    v_raw := app.to_western(app.ptext(p_payload, 'name', 160));
    IF v_raw ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{1,39}$' THEN v_code := v_raw; END IF;
  END IF;
  v_code := upper(v_code);
  IF v_name IS NULL AND v_name_en IS NULL AND v_vat IS NULL AND v_cr IS NULL AND v_code IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'name'); END IF;

  WITH sc AS (
    SELECT c.id, c.name_ar, c.name_en, c.cr_number, c.vat_number, c.is_active,
           c.daftra_client_code, c.port_category,                                                                   -- GAPS
           coalesce(v_vat IS NOT NULL AND c.vat_number = v_vat, false) AS vat_hit,
           coalesce(v_cr IS NOT NULL AND c.cr_number = v_cr, false) AS cr_hit,
           coalesce(v_vat IS NOT NULL AND c.vat_number IS NOT NULL AND c.vat_number <> v_vat, false) AS vat_diff,
           coalesce(v_cr IS NOT NULL AND c.cr_number IS NOT NULL AND c.cr_number <> v_cr, false) AS cr_diff,
           EXISTS (SELECT 1 FROM public.client_aliases a WHERE a.client_id = c.id AND a.status = 'approved'      -- LEGACY
                      AND (a.alias_norm = v_name OR a.alias_norm = v_name_en)) AS alias_hit,
           coalesce(app.norm_name(c.name_ar) IN (v_name, v_name_en), false)
             OR coalesce(app.norm_name(c.name_en) IN (v_name, v_name_en), false) AS name_hit,
           greatest(app.name_sim(v_name, app.norm_name(c.name_ar)), app.name_sim(v_name, app.norm_name(c.name_en)),
                    app.name_sim(v_name_en, app.norm_name(c.name_ar)), app.name_sim(v_name_en, app.norm_name(c.name_en)),
                    (SELECT max(greatest(app.name_sim(v_name, a.alias_norm), app.name_sim(v_name_en, a.alias_norm)))
                       FROM public.client_aliases a WHERE a.client_id = c.id AND a.status <> 'rejected')) AS sim,  -- LEGACY
           -- GAPS: exact / prefix Daftra code; a client name with a word starting with the typed text (norm_name keeps
           -- [0-9a-zء-ي ] only, so the LIKE pattern holds no wildcard)
           coalesce(v_code IS NOT NULL AND upper(c.daftra_client_code) = v_code, false) AS code_hit,
           coalesce(v_code IS NOT NULL AND char_length(v_code) >= 2 AND upper(c.daftra_client_code) <> v_code
                    AND starts_with(upper(c.daftra_client_code), v_code), false) AS code_prefix,
           EXISTS (SELECT 1 FROM unnest(ARRAY[v_name, v_name_en]) qn(s), unnest(ARRAY[app.norm_name(c.name_ar), app.norm_name(c.name_en)]) cn(s)
                    WHERE char_length(qn.s) >= 2 AND cn.s IS NOT NULL AND (' ' || cn.s) LIKE '% ' || qn.s || '%') AS name_prefix
      FROM public.clients c
     WHERE c.org_id = p_org),
  m AS (
    SELECT sc.*,
           CASE WHEN vat_hit OR cr_hit OR code_hit THEN 'strong' WHEN alias_hit OR name_hit THEN 'alias'
                WHEN sim >= 0.34 OR code_prefix OR name_prefix THEN 'weak' END AS match,
           CASE WHEN vat_hit OR cr_hit OR code_hit THEN 3 WHEN alias_hit OR name_hit THEN 2 ELSE 1 END AS rank
      FROM sc),
  r AS (SELECT * FROM m WHERE match IS NOT NULL ORDER BY rank DESC, code_prefix DESC, sim DESC, name_ar LIMIT 20)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'client_id', r.id, 'name_ar', r.name_ar, 'name_en', r.name_en, 'cr_number', r.cr_number,
           'vat_number', r.vat_number, 'is_active', r.is_active, 'match', r.match, 'rank', r.rank, 'score', r.sim,
           'daftra_client_code', r.daftra_client_code, 'port_category', r.port_category,                            -- GAPS
           'reasons', to_jsonb(array_remove(ARRAY[
              CASE WHEN r.vat_hit THEN 'vat_number' END, CASE WHEN r.cr_hit THEN 'cr_number' END,
              CASE WHEN r.code_hit THEN 'daftra_code' END,                                                          -- GAPS
              CASE WHEN r.alias_hit THEN 'alias' END, CASE WHEN r.name_hit THEN 'name' END,
              CASE WHEN r.match = 'weak' AND r.sim >= 0.34 THEN 'similar_name' END,
              CASE WHEN r.match = 'weak' AND r.code_prefix THEN 'daftra_code_prefix' END,                           -- GAPS
              CASE WHEN r.match = 'weak' AND r.name_prefix AND r.sim < 0.34 THEN 'name_prefix' END,                 -- GAPS
              CASE WHEN r.vat_diff THEN 'vat_differs' END, CASE WHEN r.cr_diff THEN 'cr_differs' END], NULL)))
           ORDER BY r.rank DESC, r.code_prefix DESC, r.sim DESC, r.name_ar), '[]'::jsonb),
         (count(*) FILTER (WHERE r.rank >= 2) > 1)
           OR bool_or(r.rank = 3 AND (r.vat_diff OR r.cr_diff)) IS TRUE
    INTO v_out, v_conflict
    FROM r;

  RETURN jsonb_build_object('candidates', v_out, 'conflict', coalesce(v_conflict, false), 'linked', false);
END $$;

-- ---------------------------------------------------------------------
-- 2. the client category + Daftra client code from the #clients edit dialog
-- ---------------------------------------------------------------------
-- set_client_legacy_fields(p_client, {port_category?: 'airport'|'port'|'shared'|null, daftra_client_code?: text|null}) →
--   {client_id, port_category, daftra_client_code, changed}. Only the keys sent change ('' / null clears). Who: the roles of
--   the clients_update policy (ops writers of the client's org); a client of another org / not visible → MRS_NOT_FOUND client.
--   Definer: daftra_client_code is immutable for API writes (app.tg_clients_legacy_guard); this RPC is its staff path.
CREATE OR REPLACE FUNCTION public.set_client_legacy_fields(p_client uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := p_payload; v_c public.clients; v_cat text; v_code text; v_other uuid; v_changed boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['port_category','daftra_client_code']);
  IF NOT (p ? 'port_category' OR p ? 'daftra_client_code') THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  SELECT * INTO v_c FROM public.clients c WHERE c.id = p_client FOR UPDATE;
  IF v_c.id IS NULL OR NOT app.is_staff(v_c.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  IF NOT app.has_role(v_c.org_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'client_edit'); END IF;
  v_cat := v_c.port_category; v_code := v_c.daftra_client_code;
  IF p ? 'port_category' THEN
    v_cat := lower(app.ptext(p, 'port_category', 20));
    IF v_cat IS NOT NULL AND NOT app.is_code('client_port_category', v_cat) THEN PERFORM app.fail('MRS_INVALID', 'port_category'); END IF;
  END IF;
  IF p ? 'daftra_client_code' THEN
    v_code := app.to_western(app.ptext(p, 'daftra_client_code', 40));
    IF v_code IS NOT NULL AND v_code !~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$' THEN PERFORM app.fail('MRS_INVALID', 'daftra_client_code'); END IF;
    IF v_code IS NOT NULL THEN
      SELECT c.id INTO v_other FROM public.clients c
       WHERE c.org_id = v_c.org_id AND c.id <> v_c.id AND upper(c.daftra_client_code) = upper(v_code) LIMIT 1;
      IF v_other IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'daftra_client_code_taken'); END IF;
    END IF;
  END IF;
  IF v_cat IS DISTINCT FROM v_c.port_category OR v_code IS DISTINCT FROM v_c.daftra_client_code THEN
    BEGIN
      UPDATE public.clients c SET port_category = v_cat, daftra_client_code = v_code WHERE c.id = v_c.id;
    EXCEPTION WHEN unique_violation THEN
      PERFORM app.fail('MRS_INVALID', 'daftra_client_code_taken');
    END;
    v_changed := true;
  END IF;
  RETURN jsonb_build_object('client_id', v_c.id, 'port_category', v_cat, 'daftra_client_code', v_code, 'changed', v_changed);
END $$;

-- staff_internal_fields (20261117000100 body; GAPS: clients + daftra_client_code, port_category)
CREATE OR REPLACE FUNCTION public.staff_internal_fields(p_table text, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_ids) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  IF p_table = 'transactions' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(t.id::text, jsonb_build_object('notes', t.notes, 'financial_status', t.financial_status,
                                                             'declaration_notes', t.declaration_notes,           -- LEGACY
                                                             'cancel_reason', t.cancel_reason, 'cancelled_by', t.cancelled_by))
        FROM public.transactions t
       WHERE t.id = ANY (p_ids) AND app.has_branch_role(t.org_id, t.branch_id, app.staff_roles())), '{}'::jsonb);
  ELSIF p_table = 'clients' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(c.id::text, jsonb_build_object('notes', c.notes, 'classification', c.classification,
                                                             'daftra_client_code', c.daftra_client_code,         -- GAPS
                                                             'port_category', c.port_category))
        FROM public.clients c
       WHERE c.id = ANY (p_ids) AND app.is_staff(c.org_id)), '{}'::jsonb);
  ELSIF p_table = 'customs_declarations' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(d.id::text, jsonb_build_object('notes', d.notes, 'cancel_reason', d.cancel_reason))
        FROM public.customs_declarations d
       WHERE d.id = ANY (p_ids) AND app.has_tx_role(d.transaction_id, app.staff_roles())), '{}'::jsonb);
  ELSIF p_table = 'bills_of_lading' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(b.id::text, jsonb_build_object('notes', b.notes))
        FROM public.bills_of_lading b
       WHERE b.id = ANY (p_ids) AND app.can_read_bl(b.id, b.org_id)), '{}'::jsonb);
  END IF;
  PERFORM app.fail('MRS_INVALID', 'table');
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 3. the follow-up employee (transactions.responsible_user_id)
-- ---------------------------------------------------------------------
-- a new / changed value = an active staff member of the transaction's org who can reach its branch (org-wide, or a member
--   of that branch while it is active — the has_branch_role rule, the same set list_assignable_staff offers); definer: reads
--   memberships whatever the caller
CREATE OR REPLACE FUNCTION app.tg_transactions_responsible() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.responsible_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.responsible_user_id IS DISTINCT FROM OLD.responsible_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.memberships m
                      WHERE m.user_id = NEW.responsible_user_id AND m.org_id = NEW.org_id AND m.is_active
                        AND m.role = ANY (app.staff_roles())
                        AND (m.branch_id IS NULL
                             OR (m.branch_id = NEW.branch_id
                                 AND EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active)))) THEN
    PERFORM app.fail('MRS_INVALID', 'responsible_user_id');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_responsible ON public.transactions;
CREATE TRIGGER trg_responsible BEFORE INSERT OR UPDATE OF responsible_user_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_responsible();

-- list_assignable_staff(p_org, p_branch?) → {rows [{user_id, full_name}]} — the employees a transaction may be followed up
--   by: active staff memberships of the org (never client-portal users) that reach the branch (org-wide, or a member of that
--   active branch — the trg_responsible rule); with p_branch, the org-wide members and that branch's members; without it,
--   every branch for an org-wide ops writer, the org-wide members only for a branch-scoped one. Only the people who may set
--   responsible_user_id (ops writers; with p_branch, of that branch) may call it, and only names are returned (roles and
--   branch assignments stay behind memberships_select). ≤ 500 rows, by name.
CREATE OR REPLACE FUNCTION public.list_assignable_staff(p_org uuid, p_branch uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_res jsonb; v_wide boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch AND b.org_id = p_org) THEN
    PERFORM app.fail('MRS_INVALID', 'branch_id');
  END IF;
  IF NOT app.has_role(p_org, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF p_branch IS NOT NULL AND NOT app.has_branch_role(p_org, p_branch, app.ops_writer_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'branch');
  END IF;
  v_wide := app.has_branch_role(p_org, NULL, app.ops_writer_roles());   -- org-wide writer (branch_id NULL membership)
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'full_name', x.full_name)
           ORDER BY x.full_name NULLS LAST, x.user_id), '[]'::jsonb))
    INTO v_res
    FROM (SELECT m.user_id, max(pr.full_name) full_name
            FROM public.memberships m LEFT JOIN public.profiles pr ON pr.id = m.user_id
           WHERE m.org_id = p_org AND m.is_active AND m.role = ANY (app.staff_roles())
             AND (m.branch_id IS NULL OR EXISTS (SELECT 1 FROM public.branches b WHERE b.id = m.branch_id AND b.is_active))
             AND (m.branch_id IS NULL OR (p_branch IS NULL AND v_wide) OR m.branch_id = p_branch)
           GROUP BY m.user_id
           ORDER BY max(pr.full_name) NULLS LAST, m.user_id
           LIMIT 500) x;
  RETURN v_res;
END $$;

-- ---------------------------------------------------------------------
-- 5. custody_balances (20261122000100 body; GAPS: + client_code, q on the code, org totals)
-- ---------------------------------------------------------------------
-- custody_balances(p_org, {q?, nonzero?}) → {rows [{client_id, client_name, client_code, balance, total_deposits, total_deductions,
--   total_refunds, entry_count, last_entry_date}], total_balance, total_deposits, total_deductions, total_refunds, client_count}
--   — org-wide figures per client (a finance reader anywhere in the org); the totals cover the rows q selects (nonzero only
--   hides rows)
CREATE OR REPLACE FUNCTION public.custody_balances(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['q','nonzero']);
  v_q := app.legacy_search_key(app.ptext(f, 'q', 120));
  WITH b AS (
    SELECT e.client_id, c.name_ar, c.daftra_client_code code, sum(e.signed_amount) bal,                              -- GAPS code
           coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deposit'), 0) dep, coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deduction'), 0) ded,
           coalesce(sum(e.amount) FILTER (WHERE e.kind = 'refund'), 0) ref, count(*) n, max(e.entry_date) last
      FROM public.client_custody_entries e JOIN public.clients c ON c.id = e.client_id
     WHERE e.org_id = p_org AND e.status = 'active'
       AND (v_q IS NULL OR position(v_q IN app.legacy_search_key(c.name_ar)) > 0
            OR coalesce(starts_with(app.legacy_search_key(c.daftra_client_code), v_q), false))                        -- GAPS
     GROUP BY e.client_id, c.name_ar, c.daftra_client_code)
  SELECT jsonb_build_object('rows', coalesce((SELECT jsonb_agg(jsonb_build_object('client_id', b.client_id, 'client_name', b.name_ar,
           'client_code', b.code, 'balance', b.bal,                                                                    -- GAPS
           'total_deposits', b.dep, 'total_deductions', b.ded, 'total_refunds', b.ref, 'entry_count', b.n, 'last_entry_date', b.last)
           ORDER BY b.bal DESC, b.name_ar) FROM b WHERE NOT app.pbool(f, 'nonzero') OR b.bal <> 0), '[]'::jsonb),
         'total_balance', (SELECT coalesce(sum(b.bal), 0) FROM b),
         -- GAPS: the KPI tiles
         'total_deposits', (SELECT coalesce(sum(b.dep), 0) FROM b), 'total_deductions', (SELECT coalesce(sum(b.ded), 0) FROM b),
         'total_refunds', (SELECT coalesce(sum(b.ref), 0) FROM b), 'client_count', (SELECT count(*)::int FROM b))
    INTO v_res;
  RETURN v_res;
END $$;

-- ---------------------------------------------------------------------
-- 6. report_trips (20261124000100 body; GAPS: party_type 'unset', declaration / TASTO order / client id on rows, transport_value)
-- ---------------------------------------------------------------------
-- the party_type filter: transport_party_type codes and 'unset' (= no party type on the trip and no carrier; a carrier alone
--   counts as 'company', the by_carrier rule); invalid → MRS_INVALID party_type
CREATE OR REPLACE FUNCTION app.rpt_party_types(f jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := f -> 'party_type'; r text[]; u boolean := false;
BEGIN
  IF jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = 'unset' THEN RETURN ARRAY['unset']; END IF;
  IF jsonb_typeof(v) = 'array' AND v @> '["unset"]'::jsonb THEN
    u := true;
    SELECT coalesce(jsonb_agg(e), '[]'::jsonb) INTO v FROM jsonb_array_elements(f -> 'party_type') e WHERE e <> '"unset"'::jsonb;
  END IF;
  r := app.rpt_codes(jsonb_build_object('party_type', v), 'party_type', 'transport_party_type');
  IF u THEN r := coalesce(r, '{}'::text[]) || 'unset'::text; END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.report_trips(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_cl uuid; v_car uuid; v_st text[]; v_rng date[]; v_from date; v_to date;
  v_fin boolean; v_sort text; v_limit int; v_offset int; v_ids uuid[]; v_total int; v_fp text; v_items jsonb; v_by jsonb;
  v_cost jsonb; v_sell jsonb; v_nfin int; v_late boolean; v_tf timestamptz; v_tt timestamptz; v_sc uuid[]; v_tsc uuid[];
  v_drv uuid; v_drq text; v_pt text[]; v_ptq text; v_q text; v_qp text; v_qn text; v_qc text; v_byc jsonb; v_byd jsonb;  -- RPT
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
  -- RPT
  v_drv := app.puuid(f, 'driver_id');
  v_drq := app.rpt_like(app.ptext(f, 'driver_q', 80));
  v_pt := app.rpt_party_types(f);                                                                                   -- GAPS: + 'unset'
  v_ptq := app.rpt_like(app.ptext(f, 'party_q', 80));
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(app.to_western(v_q)); v_qn := app.rpt_like(app.rpt_norm_no(v_q)); v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  v_tsc := CASE WHEN v_fin THEN app.rpt_scope(p_org, app.trip_finance_roles()) ELSE '{}'::uuid[] END;
  SELECT array_agg(tr.id) INTO v_ids
    FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
    JOIN public.clients cl ON cl.id = t.client_id
    LEFT JOIN public.parties pa ON pa.id = tr.carrier_id
    LEFT JOIN public.drivers d ON d.id = tr.driver_id
    LEFT JOIN public.trucks k ON k.id = tr.truck_id
    LEFT JOIN public.containers c ON c.id = tr.container_id
   WHERE t.org_id = p_org AND tr.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_car IS NULL OR tr.carrier_id = v_car)
     AND (v_st IS NULL OR tr.status = ANY (v_st))
     AND (NOT v_late OR (tr.status IN ('planned','dispatched') AND tr.planned_at < now()))
     AND (v_tf IS NULL OR tr.planned_at >= v_tf) AND (v_tt IS NULL OR tr.planned_at < v_tt)
     -- RPT
     AND (v_drv IS NULL OR tr.driver_id = v_drv)
     AND (v_drq IS NULL OR d.full_name ILIKE v_drq)
     -- GAPS: the effective party type (a carrier without a party type = 'company', as by_carrier groups it); 'unset' = neither
     AND (v_pt IS NULL OR coalesce(tr.party_type, CASE WHEN tr.carrier_id IS NOT NULL THEN 'company' END, 'unset') = ANY (v_pt))
     AND (v_ptq IS NULL OR tr.party_name ILIKE v_ptq OR pa.name_ar ILIKE v_ptq OR pa.name_en ILIKE v_ptq)
     AND (v_q IS NULL OR t.ref ILIKE v_qn OR cl.name_ar ILIKE v_qp OR cl.name_en ILIKE v_qp OR t.declaration_no ILIKE v_qn
          OR c.container_no ILIKE v_qc OR tr.party_name ILIKE v_qp OR pa.name_ar ILIKE v_qp OR d.full_name ILIKE v_qp
          OR k.plate_no ILIKE v_qn OR tr.transport_order_no ILIKE v_qn OR t.transport_order_no ILIKE v_qn
          OR EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.id = tr.appointment_id AND a.appointment_no ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.customs_declarations x WHERE x.transaction_id = t.id AND x.declaration_no ILIKE v_qn));
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
  -- RPT: groups by transport party and by driver (legacy byParty / byDriver)
  WITH g AS (
    SELECT tr.id, coalesce(tr.party_type, CASE WHEN tr.carrier_id IS NOT NULL THEN 'company' END) pt,
           coalesce(nullif(btrim(tr.party_name), ''), pa.name_ar) pn, tr.carrier_id, tr.driver_id, d.full_name dn,
           CASE WHEN v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc)) THEN tr.cost_amount END amt, tr.cost_currency cur
      FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
      LEFT JOIN public.parties pa ON pa.id = tr.carrier_id LEFT JOIN public.drivers d ON d.id = tr.driver_id
     WHERE tr.id = ANY (v_ids)),
  gc AS (SELECT g.pt, g.pn, min(g.carrier_id::text)::uuid car, count(*)::int n,
                (SELECT coalesce(jsonb_object_agg(z.cur, z.s), '{}'::jsonb)
                   FROM (SELECT g2.cur, round(sum(g2.amt), 2) s FROM g g2
                          WHERE g2.pt IS NOT DISTINCT FROM g.pt AND g2.pn IS NOT DISTINCT FROM g.pn AND g2.amt IS NOT NULL GROUP BY 1) z) v
           FROM g GROUP BY g.pt, g.pn),
  gd AS (SELECT g.driver_id, max(g.dn) dn, count(*)::int n,
                (SELECT coalesce(jsonb_object_agg(z.cur, z.s), '{}'::jsonb)
                   FROM (SELECT g2.cur, round(sum(g2.amt), 2) s FROM g g2
                          WHERE g2.driver_id IS NOT DISTINCT FROM g.driver_id AND g2.amt IS NOT NULL GROUP BY 1) z) v
           FROM g GROUP BY g.driver_id)
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('party_type', gc.pt, 'party_name', gc.pn, 'carrier_id', gc.car, 'trips', gc.n,
                   'value_by_currency', gc.v) ORDER BY gc.n DESC, gc.pn NULLS LAST, gc.pt NULLS LAST), '[]'::jsonb)
            FROM (SELECT * FROM gc ORDER BY gc.n DESC, gc.pn NULLS LAST LIMIT 200) gc),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('driver_id', gd.driver_id, 'driver_name', gd.dn, 'trips', gd.n,
                   'value_by_currency', gd.v) ORDER BY gd.n DESC, gd.dn NULLS LAST), '[]'::jsonb)
            FROM (SELECT * FROM gd ORDER BY gd.n DESC, gd.dn NULLS LAST LIMIT 200) gd)
    INTO v_byc, v_byd;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'transaction_id', p.transaction_id, 'transaction_ref', p.ref,
           'container_no', p.container_no, 'leg_no', p.leg_no, 'carrier_name', p.carrier_name, 'driver_name', p.driver_name,
           'truck_plate', p.truck_plate, 'origin', p.origin, 'destination', p.destination, 'planned_at', p.planned_at,
           'loaded_at', p.loaded_at, 'unloaded_at', p.unloaded_at, 'status', p.status,
           'cost_amount', CASE WHEN p.fin THEN round(p.cost_amount, 2) END, 'cost_currency', CASE WHEN p.fin THEN p.cost_currency END,
           'sell_amount', CASE WHEN p.fin THEN round(p.sell_amount, 2) END, 'sell_currency', CASE WHEN p.fin THEN p.sell_currency END,
           'driver_id', p.driver_id, 'driver_phone', p.driver_phone,                                                  -- RPT
           'party_type', coalesce(p.party_type, CASE WHEN p.carrier_id IS NOT NULL THEN 'company' END),          -- GAPS: effective
           'party_name', coalesce(nullif(btrim(p.party_name), ''), p.carrier_name), 'transport_order_no', p.transport_order_no,
           'client_name', p.client_name, 'appointment_no', p.appointment_no, 'appointment_at', p.appointment_at)
           -- GAPS: the transaction's declaration number, TASTO carrier order and client
           || jsonb_build_object('declaration_no', p.tx_declaration_no, 'tx_transport_order_no', p.tx_order_no,
                                 'tx_transport_order_date', p.tx_order_date, 'client_id', p.tx_client_id)
           ORDER BY p.o), '[]'::jsonb)
    INTO v_items
    FROM (SELECT tr.*, t.ref, c.container_no, pa.name_ar carrier_name, d.full_name driver_name, d.phone driver_phone, k.plate_no truck_plate,
                 cl.name_ar client_name, ap.appointment_no, ap.appointment_at,
                 t.declaration_no tx_declaration_no, t.transport_order_no tx_order_no, t.transport_order_date tx_order_date,   -- GAPS
                 t.client_id tx_client_id,
                 (v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc))) fin,
                 row_number() OVER (ORDER BY
                   CASE WHEN v_sort = 'planned_desc' THEN tr.planned_at END DESC NULLS LAST,
                   CASE WHEN v_sort = 'planned_asc' THEN tr.planned_at END ASC NULLS LAST,
                   tr.id) o
            FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
            JOIN public.clients cl ON cl.id = t.client_id
            LEFT JOIN public.containers c ON c.id = tr.container_id
            LEFT JOIN public.parties pa ON pa.id = tr.carrier_id
            LEFT JOIN public.drivers d ON d.id = tr.driver_id
            LEFT JOIN public.trucks k ON k.id = tr.truck_id
            LEFT JOIN public.port_appointments ap ON ap.id = tr.appointment_id
           WHERE tr.id = ANY (v_ids)) p
   WHERE p.o > v_offset AND p.o <= v_offset + v_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'fingerprint', v_fp,
    'include_finance', v_fin, 'late', v_late,
    'totals', jsonb_build_object('count', v_total, 'by_status', v_by,
      'finance', jsonb_build_object('cost_by_currency', v_cost, 'sell_by_currency', v_sell, 'rows_with_finance', v_nfin),
      'by_carrier', v_byc, 'by_driver', v_byd,                                                                        -- RPT
      'transport_value', v_cost));                                                                                    -- GAPS
END $$;

-- ---------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------
-- internal helpers / trigger functions: never callable through the API
REVOKE ALL ON FUNCTION app.tg_transactions_responsible(), app.rpt_party_types(jsonb) FROM PUBLIC, anon, authenticated;
-- re-created functions: privileges as in their first migration (CREATE OR REPLACE keeps them; restated)
REVOKE EXECUTE ON FUNCTION public.match_client(uuid, jsonb), public.staff_internal_fields(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_client(uuid, jsonb), public.staff_internal_fields(text, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.custody_balances(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.custody_balances(uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.report_trips(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_trips(uuid, jsonb) TO authenticated;
-- new staff RPCs: authenticated only (each checks its own gate)
REVOKE ALL ON FUNCTION public.set_client_legacy_fields(uuid, jsonb), public.list_assignable_staff(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_client_legacy_fields(uuid, jsonb), public.list_assignable_staff(uuid, uuid) TO authenticated;
