-- =====================================================================
-- Marsa (مرسى) — TEST DATA SEED for the org whose slug is 'marsa' («مؤسسة البحر الأزرق»).
-- NOT a migration: never add it to all_migrations.sql / the migration lists. Paste the WHOLE file into the
-- Supabase SQL Editor and press Run once (the editor wraps it in one transaction: any error = nothing is written).
-- Remove everything again with supabase/seed/test_data_cleanup.sql. Arabic note: supabase/seed/README_TEST_DATA_AR.md.
--
-- What it creates (all obviously fake; every client name starts with «تجريبي — », every row that has a free-text field
-- carries 'TEST-SEED'):
--   · 11 test parties «تجريبي — …» (2 terminal operators mapped to SAJED / SADMM, 3 shipping agents, 2 transport
--     companies, 1 return yard, 1 customs authority, 1 electricity company, 1 transport supplier)
--   · 20 test clients (Daftra codes TST-1001 … TST-1020, port category airport / port / shared, no e-mail / phone)
--   · 61 transactions (2–4 per client; B/L TESTBL…; MRS-… refs from the normal numbering) spread over every
--     operational status: new, in_progress, customs_declaration (every Fasah stage), appointment, transport,
--     empty_return, operationally_complete, under_billing, billed (set by hand by the finance role — no Daftra), closed,
--     and one cancelled; sea / air / Ro-Ro (chassis + plate) / re-export; containers TSTU…… with valid ISO 6346 check
--     digits, seal + size; declarations TSTD…… with Gregorian + (tabular) Hijri dates
--   · its OWN fleet: 8 drivers «تجريبي — سائق …» (0500000101 … 0500000108) and 6 trucks TST1001 … TST1006, inserted as
--     new rows and handed to the movements by id (never find-or-create by phone / plate, so no existing driver or truck
--     is ever taken over, renamed or re-pointed)
--   · appointments (TAS…), movements (trips with those drivers / trucks, transport value / org revenue, party type
--     supplier / company / direct / unset), empty-return deadlines (some overdue), passed appointments that raise the
--     follow-up / critical badges, waived returns (documented exception)
--   · coherent dates per transaction, from one stage-dependent anchor: ETA (future for new / in progress, in the past
--     from the customs stage on) ≤ declaration date ≤ delivery ≤ return; payments between the declaration date and
--     today. created_at stays the real insert time (it decides the subscription usage month the cleanup gives back).
--   · stage-aging clocks: updated_at of the test transactions set back, staggered by the org's aging rules (fresh /
--     warning / critical in every status that has a rule), and some open declarations older than 3 days («declaration
--     stalled») — so the «late in stage» badges can be tried right away
--   · ~80 payment-register entries (every movement type, 6 funding sources, 6 methods, 8 service items; some with an
--     invoice no. = a G4 supplier invoice + payment) — ALL left 'pending' / 'draft': approval is four-eyes (the approver
--     must not be the creator) and the seed acts as ONE user (it never impersonates a second real staff member)
--   · one shared (aggregated) payment with 3 allocations
--   · client custody for 6 clients: deposits, deductions (linked to a custody-funded payment), refunds
-- What it never creates: auth users, memberships, branches, billing intents, Daftra jobs / pushes / invoices,
-- e-mail / message outbox rows, client charges (charge_client is never set), documents / storage files.
--
-- How: it impersonates the org-wide admin (request.jwt.claims + SET LOCAL ROLE authenticated) and goes through the
-- same table writes / RPCs the screens use (RLS, guards, numbering, lifecycle triggers, audit rows as in the app).
-- Exceptions (no RPC without a real file): container returns are recorded as documented WAIVERS (an empty-return proof
-- needs an uploaded EIR document), and the trip «party type» (set only by approving an appointment card = a file) is
-- written as the database owner on the test trips only. Stage moves the mandatory-documents gate would block are made
-- with the admin's explicit override (p_docs_override + reason 'TEST-SEED …'), exactly what the override dialog does.
-- Refuses to run twice (idempotency marker = any «تجريبي — » client / party or a TESTBL… B/L in the org), and refuses
-- when the org already has a driver named «تجريبي — …» or with one of the test mobiles (any spelling), or a truck with a
-- TST… plate: the cleanup takes those for test rows.
-- The stage-aging clocks: the touch triggers (app.touch_updated_at) of transactions / customs_declarations are switched
-- off (ALTER TABLE … DISABLE TRIGGER, the owner role can) for the one UPDATE of the test rows' updated_at, then back to
-- their previous state — a short exclusive lock on those two tables: run the seed at a quiet moment.
-- =====================================================================

DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;

DO $seed$
DECLARE
  c_prefix constant text := 'تجريبي — ';
  c_mark   constant text := 'TEST-SEED';
  c_order  constant text[] := ARRAY['new','in_progress','customs_declaration','appointment','transport','empty_return',
                                    'operationally_complete','under_billing','billed','closed'];
  v_orig_role text := current_user;
  v_org uuid; v_admin uuid; v_branch uuid; v_n int; v_lim jsonb; v_used bigint;
  -- parties
  p_op1 uuid; p_op2 uuid; p_ag uuid[] := '{}'; p_car uuid[] := '{}'; p_yard uuid; p_customs uuid; p_elec uuid; p_tsup uuid;
  v_pid uuid;
  -- clients
  v_cnames text[] := ARRAY[
    'مؤسسة الأفق الوهمية للتجارة', 'Mirage Imports Co. (Test)', 'شركة السراب للاستيراد', 'Placeholder Trading LLC',
    'مؤسسة النموذج الأول', 'Dummy Logistics Est.', 'شركة المثال للتجهيزات', 'Sample Foods Trading',
    'مؤسسة اختبار الشحن', 'Fictional Auto Parts Co.', 'شركة الوهم للمواد الغذائية', 'Example Electronics Est.',
    'مؤسسة التجربة للأثاث', 'Mock Textiles Trading', 'شركة الافتراض للمعدات', 'Demo Medical Supplies',
    'مؤسسة الخيال للأجهزة', 'Pretend Building Materials', 'شركة التمثيل للقطع', 'Imaginary Toys Trading'];
  v_cats text[] := ARRAY['airport','port','shared'];
  v_clients uuid[] := '{}'; v_cid uuid; k int; j int; i int;
  -- plan
  v_plan text[];
  v_tx uuid; v_txs uuid[] := '{}'; v_tx_status text[] := '{}'; v_tx_client uuid[] := '{}'; v_tx_cont int[] := '{}';
  s text; v_mode text; v_cargo text; v_type text; v_op text; v_port text; v_term uuid; v_ncont int; v_bl text; v_bl_id uuid;
  v_ctr uuid; v_ctrs uuid[]; v_ctr_no text; v_body text; v_sum int; v_cd int; v_ch text; v_val int;
  v_decl jsonb; v_dstage text; v_ddate date; v_hijri text; v_jd int; v_l int; v_hn int; v_hj int; v_hm int; v_hd int; v_hy int;
  v_cur text; v_next text; v_res jsonb; v_at timestamptz; v_party int; v_trip_no int := 0; v_ms text; v_ret date;
  v_drv_names text[] := ARRAY['سائق أول','سائق ثان','سائق ثالث','سائق رابع','سائق خامس','سائق سادس','سائق سابع','سائق ثامن'];
  v_ports_sea text[] := ARRAY['SAJED','SADMM','SAKAC','SARUH'];
  v_ports_air text[] := ARRAY['SAJED-AIR','SADMM-AIR','SARUH-AIR'];
  v_sizes text[] := ARRAY['40HC','20GP','45G1'];
  v_ctypes text[] := ARRAY['40hc','20ft','45ft'];
  v_goods text[] := ARRAY['بضائع تجريبية — قطع غيار','بضائع تجريبية — مواد غذائية','بضائع تجريبية — أجهزة','بضائع تجريبية — أقمشة','بضائع تجريبية — أثاث'];
  v_dstages text[] := ARRAY['submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment','release_ready','draft'];
  -- payments
  v_pay int := 0; v_p jsonb; v_kind int; v_svc text; v_disb uuid; v_cust_clients uuid[] := '{}'; v_cust_tx uuid[] := '{}';
  -- fleet / dates / mix / aging
  v_phones text[] := ARRAY(SELECT '0500000' || (101 + g) FROM generate_series(0, 7) g);
  v_drv uuid[] := '{}'; v_trk uuid[] := '{}'; v_si int; v_eta date; v_tx_ddate date[] := '{}'; v_dlv timestamptz[];
  v_ord jsonb := '{}'; v_occ int; v_cust_svc text; v_rules jsonb; v_trg jsonb;
BEGIN
  -- ------------------------------------------------------------------ 1. locate (as the database owner)
  SELECT o.id INTO v_org FROM public.organizations o WHERE o.slug = 'marsa';
  IF v_org IS NULL THEN RAISE EXCEPTION 'TEST SEED: no organization with slug ''marsa''. Nothing was changed.'; END IF;
  SELECT m.user_id INTO v_admin FROM public.memberships m
   WHERE m.org_id = v_org AND m.role = 'admin' AND m.branch_id IS NULL AND m.is_active
   ORDER BY m.created_at, m.user_id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'TEST SEED: the org ''marsa'' has no active org-wide admin membership (role admin, no branch). Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients c WHERE c.org_id = v_org AND c.name_ar LIKE c_prefix || '%')
     OR EXISTS (SELECT 1 FROM public.parties p WHERE p.org_id = v_org AND p.name_ar LIKE c_prefix || '%')
     OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.org_id = v_org AND t.bl_number LIKE 'TESTBL%')
     OR EXISTS (SELECT 1 FROM public.bills_of_lading b WHERE b.org_id = v_org AND b.bl_number LIKE 'TESTBL%') THEN
    RAISE EXCEPTION 'TEST SEED: test data already exists in ''marsa'' (a «تجريبي — » client / party or a TESTBL B/L). Run test_data_cleanup.sql first. Nothing was changed.';
  END IF;
  -- the fleet markers: the cleanup deletes drivers «تجريبي — …» and trucks TST…, and the movement form finds a driver by
  -- mobile (any spelling) — an existing row with one of these would be taken for a test row
  IF EXISTS (SELECT 1 FROM public.drivers d WHERE d.org_id = v_org
               AND (d.full_name LIKE c_prefix || '%' OR d.phone = ANY (v_phones) OR app.norm_sa_phone(d.phone, false) = ANY (v_phones)))
     OR EXISTS (SELECT 1 FROM public.trucks k WHERE k.org_id = v_org AND k.plate_no ~ '^TST[0-9]+$') THEN
    RAISE EXCEPTION 'TEST SEED: the org ''marsa'' already has a driver named «تجريبي — …» or with a test mobile 0500000101 … 0500000108 (any spelling), or a truck with a TST… plate — the test data would take it over and the cleanup would delete it. Change it in the fleet screen first. Nothing was changed.';
  END IF;
  -- the branch: the active branch most existing transactions use, else the first active branch by code
  SELECT b.id INTO v_branch FROM public.branches b
    LEFT JOIN public.transactions t ON t.branch_id = b.id
   WHERE b.org_id = v_org AND b.is_active
   GROUP BY b.id, b.code ORDER BY count(t.id) DESC, b.code LIMIT 1;
  IF v_branch IS NULL THEN RAISE EXCEPTION 'TEST SEED: the org ''marsa'' has no active branch. Nothing was changed.'; END IF;
  -- the subscription must allow 61 more transactions this month (else the plan limit would stop the seed half way)
  PERFORM app.g7_assert_active(v_org);
  v_lim := app.g7_limits(v_org) -> 'transactions_month';
  SELECT coalesce(max(u.value), 0) INTO v_used FROM public.org_usage_counters u
   WHERE u.org_id = v_org AND u.metric = 'transactions_month' AND u.period_start = app.g7_period(now());
  IF jsonb_typeof(v_lim) = 'number' AND v_used + 61 > (v_lim #>> '{}')::bigint THEN
    RAISE EXCEPTION 'TEST SEED: the plan allows % transactions this month, % used — 61 test transactions do not fit. Nothing was changed.',
      v_lim #>> '{}', v_used;
  END IF;

  -- the status plan (61 transactions), interleaved so each client gets a mix
  SELECT array_agg(x.s ORDER BY (x.rn * 37) % 61, x.rn) INTO v_plan FROM unnest(
    array_fill('new'::text, ARRAY[6]) || array_fill('in_progress'::text, ARRAY[6]) || array_fill('customs_declaration'::text, ARRAY[10])
    || array_fill('appointment'::text, ARRAY[7]) || array_fill('transport'::text, ARRAY[9]) || array_fill('empty_return'::text, ARRAY[7])
    || array_fill('operationally_complete'::text, ARRAY[6]) || array_fill('under_billing'::text, ARRAY[5])
    || array_fill('billed'::text, ARRAY[3]) || ARRAY['closed','cancelled']::text[]) WITH ORDINALITY x(s, rn);

  -- ------------------------------------------------------------------ 2. act as the org-wide admin
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal1',
            'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text, true);
  SET LOCAL ROLE authenticated;

  -- parties (the directory screen writes them the same way)
  INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes) VALUES
    (v_org, ARRAY['terminal_operator'], c_prefix || 'محطة الحاويات الشمالية', 'Test North Container Terminal', c_mark) RETURNING id INTO p_op1;
  INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes) VALUES
    (v_org, ARRAY['terminal_operator'], c_prefix || 'محطة البوابة الشرقية', 'Test East Gate Terminal', c_mark) RETURNING id INTO p_op2;
  INSERT INTO public.party_ports (org_id, party_id, port_code) VALUES (v_org, p_op1, 'SAJED'), (v_org, p_op2, 'SADMM');
  FOR k IN 1 .. 3 LOOP
    INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes)
    VALUES (v_org, ARRAY['shipping_agent'], c_prefix || (ARRAY['وكيل الملاحة الأول','وكيل البحار الزرقاء','وكيل الموجة'])[k],
            'Test Shipping Agent ' || k, c_mark) RETURNING id INTO v_pid;
    p_ag := p_ag || v_pid;
  END LOOP;
  FOR k IN 1 .. 2 LOOP
    INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes)
    VALUES (v_org, ARRAY['carrier'], c_prefix || (ARRAY['شركة النقل السريع','شركة القوافل للنقل'])[k], 'Test Transport Co ' || k, c_mark)
    RETURNING id INTO v_pid;
    p_car := p_car || v_pid;
  END LOOP;
  INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes) VALUES
    (v_org, ARRAY['yard'], c_prefix || 'ساحة الإرجاع المركزية', 'Test Return Yard', c_mark) RETURNING id INTO p_yard;
  INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes) VALUES
    (v_org, ARRAY['other'], c_prefix || 'جهة الرسوم الجمركية (وهمية)', 'Test Customs Fees Authority', c_mark) RETURNING id INTO p_customs;
  INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes) VALUES
    (v_org, ARRAY['supplier'], c_prefix || 'شركة الكهرباء (وهمية)', 'Test Electricity Co', c_mark) RETURNING id INTO p_elec;
  INSERT INTO public.parties (org_id, kinds, name_ar, name_en, notes) VALUES
    (v_org, ARRAY['supplier'], c_prefix || 'مورد النقل المتعاقد', 'Test Transport Supplier', c_mark) RETURNING id INTO p_tsup;

  -- clients (insert = the clients screen; category + Daftra code = set_client_legacy_fields)
  FOR k IN 1 .. 20 LOOP
    INSERT INTO public.clients (org_id, client_type, name_ar, name_en, notes)
    VALUES (v_org, 'business', c_prefix || v_cnames[k], 'TEST — ' || v_cnames[k], c_mark || ' — بيانات وهمية للتجربة')
    RETURNING id INTO v_cid;
    PERFORM public.set_client_legacy_fields(v_cid, jsonb_build_object('port_category', v_cats[(k - 1) % 3 + 1],
                                                                      'daftra_client_code', 'TST-' || (1000 + k)));
    v_clients := v_clients || v_cid;
  END LOOP;

  -- the seed's own fleet (the fleet screen inserts them the same way); the movements get them by id
  FOR k IN 1 .. 8 LOOP
    INSERT INTO public.drivers (org_id, full_name, phone, created_by)
    VALUES (v_org, c_prefix || v_drv_names[k], v_phones[k], v_admin) RETURNING id INTO v_pid;
    v_drv := v_drv || v_pid;
  END LOOP;
  FOR k IN 1 .. 6 LOOP
    INSERT INTO public.trucks (org_id, plate_no, created_by) VALUES (v_org, 'TST' || (1000 + k), v_admin) RETURNING id INTO v_pid;
    v_trk := v_trk || v_pid;
  END LOOP;

  -- ------------------------------------------------------------------ 3. transactions
  v_n := 0;
  FOR k IN 1 .. 20 LOOP
    FOR j IN 1 .. (2 + k % 3) LOOP
      v_n := v_n + 1;
      s := coalesce(v_plan[v_n], 'new');
      -- Ro-Ro / air from a fixed per-status list (the n-th transaction of that status), so both reach several stages
      v_occ := coalesce((v_ord ->> s)::int, 0) + 1;
      v_ord := v_ord || jsonb_build_object(s, v_occ);
      v_cargo := CASE WHEN s || ':' || v_occ = ANY (ARRAY['new:1','customs_declaration:1','operationally_complete:1','under_billing:1'])
                      THEN 'roro' ELSE 'container' END;
      v_mode := CASE WHEN s || ':' || v_occ = ANY (ARRAY['new:2','in_progress:2','customs_declaration:2','operationally_complete:2'])
                     THEN 'air' ELSE 'sea' END;
      -- the date anchor: ETA in the future for new / in progress, in the past (further back for a later stage) from the
      -- customs stage on; the declaration is dated between the ETA and yesterday; everything later follows it
      v_si := array_position(c_order, s);
      v_eta := CASE WHEN v_si IS NULL THEN current_date + 3
                    WHEN v_si = 1 THEN current_date + 1 + v_n % 8
                    WHEN v_si = 2 THEN current_date - 2 + v_n % 6
                    ELSE current_date - (3 + (v_si - 3) * 2 + v_n % 4) END;
      v_ddate := CASE WHEN v_si >= 3 THEN least(v_eta + 1 + v_n % 2, current_date - 1) END;
      v_type := CASE WHEN v_n % 8 = 3 THEN 're_export' ELSE 'normal' END;
      v_op := CASE WHEN v_type = 're_export' OR v_n % 11 = 5 THEN 'export' ELSE 'import' END;
      v_port := CASE WHEN v_mode = 'air' THEN v_ports_air[v_n % 3 + 1]
                     WHEN v_cargo = 'roro' THEN v_ports_sea[v_n % 2 + 1] ELSE v_ports_sea[v_n % 4 + 1] END;
      v_term := CASE v_port WHEN 'SAJED' THEN p_op1 WHEN 'SADMM' THEN p_op2 END;
      v_ncont := CASE WHEN v_cargo = 'roro' OR v_mode = 'air' THEN 0 ELSE 1 + v_n % 3 END;
      v_bl := 'TESTBL' || lpad(v_n::text, 5, '0');
      INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, port_of_loading, port_of_discharge, country,
        goods_description, shipping_line, eta, container_count, port_code, terminal_party_id, cargo_unit_type, chassis_no,
        vehicle_plate_no, transaction_type, responsible_user_id, notes)
      VALUES (v_org, v_branch, v_clients[k], v_op, v_mode,
        CASE WHEN v_op = 'import' THEN (ARRAY['شنغهاي','جبل علي','روتردام','بوسان'])[v_n % 4 + 1] ELSE 'جدة' END,
        CASE WHEN v_op = 'import' THEN (SELECT p.name_ar FROM public.customs_ports p WHERE p.code = v_port) ELSE 'جبل علي' END,
        CASE WHEN v_op = 'import' THEN (ARRAY['الصين','الإمارات','هولندا','كوريا الجنوبية'])[v_n % 4 + 1] ELSE 'الإمارات' END,
        v_goods[v_n % 5 + 1], CASE WHEN v_mode = 'air' THEN 'TEST AIR CARGO' ELSE 'TEST SHIPPING LINE' END,
        v_eta, v_ncont, v_port, v_term, v_cargo,
        CASE WHEN v_cargo = 'roro' THEN 'TSTCHS' || lpad(v_n::text, 11, '0') END,
        CASE WHEN v_cargo = 'roro' THEN 'TST' || lpad(v_n::text, 4, '0') END,
        v_type, v_admin, c_mark)
      RETURNING id INTO v_tx;

      -- the B/L (save_bl registers it and links it as primary, like the new-transaction form)
      v_res := public.save_bl(jsonb_build_object('bl_number', v_bl, 'bl_type', CASE WHEN v_mode = 'air' THEN 'awb' ELSE 'master' END,
        'shipping_agent_id', p_ag[v_n % 3 + 1], 'carrier_name', CASE WHEN v_mode = 'air' THEN 'TEST AIR CARGO' ELSE 'TEST SHIPPING LINE' END,
        'vessel', CASE WHEN v_mode = 'sea' THEN 'TEST VESSEL ' || (ARRAY['ALPHA','BRAVO','CHARLIE','DELTA'])[v_n % 4 + 1] END,
        'voyage', CASE WHEN v_mode = 'sea' THEN 'TV' || lpad(v_n::text, 3, '0') END,
        'notes', c_mark, 'transaction_id', v_tx, 'primary', true));
      v_bl_id := coalesce((v_res ->> 'id')::uuid, (v_res ->> 'bl_id')::uuid);

      -- containers: TSTU + 6-digit serial + the ISO 6346 check digit
      v_ctrs := '{}';
      FOR i IN 1 .. v_ncont LOOP
        v_body := 'TSTU' || lpad((v_n * 10 + i)::text, 6, '0');
        v_sum := 0;
        FOR v_cd IN 1 .. 10 LOOP
          v_ch := substr(v_body, v_cd, 1);
          IF v_ch ~ '[0-9]' THEN v_val := v_ch::int;
          ELSE v_val := (ARRAY[10,12,13,14,15,16,17,18,19,20,21,23,24,25,26,27,28,29,30,31,32,34,35,36,37,38])[ascii(v_ch) - 64];
          END IF;
          v_sum := v_sum + v_val * (1 << (v_cd - 1));
        END LOOP;
        v_ctr_no := v_body || ((v_sum % 11) % 10)::text;
        INSERT INTO public.containers (org_id, transaction_id, container_no, container_type, seal_no, size_type, bl_id, notes)
        VALUES (v_org, v_tx, v_ctr_no, v_ctypes[(v_n + i) % 3 + 1], 'TSTSEAL' || lpad((v_n * 10 + i)::text, 5, '0'),
                v_sizes[(v_n + i) % 3 + 1], v_bl_id, c_mark)
        RETURNING id INTO v_ctr;
        v_ctrs := v_ctrs || v_ctr;
      END LOOP;

      v_txs := v_txs || v_tx; v_tx_status := v_tx_status || s; v_tx_client := v_tx_client || v_clients[k]; v_tx_cont := v_tx_cont || v_ncont;
      v_tx_ddate := v_tx_ddate || v_ddate;
      v_dlv := array_fill(NULL::timestamptz, ARRAY[3]);

      IF s = 'cancelled' THEN
        PERFORM public.cancel_transaction(v_tx, c_mark || ' — معاملة تجريبية ملغاة');
        CONTINUE;
      END IF;

      -- in_progress
      IF array_position(c_order, s) >= 2 THEN
        PERFORM public.set_transaction_status(v_tx, 'in_progress', c_mark, NULL, true);
      END IF;

      -- customs declaration (stage = a Fasah stage below release while the transaction is in customs, released after)
      IF array_position(c_order, s) >= 3 THEN
        v_dstage := CASE WHEN s = 'customs_declaration' THEN v_dstages[v_n % 7 + 1] ELSE 'released' END;
        -- tabular (Kuwaiti) Hijri date of v_ddate — close to Umm al-Qura (± 1 day), good enough for test data
        v_jd := to_char(v_ddate, 'J')::int;
        v_l := v_jd - 1948440 + 10632;
        v_hn := (v_l - 1) / 10631;
        v_l := v_l - 10631 * v_hn + 354;
        v_hj := ((10985 - v_l) / 5316) * ((50 * v_l) / 17719) + (v_l / 5670) * ((43 * v_l) / 15238);
        v_l := v_l - ((30 - v_hj) / 15) * ((17719 * v_hj) / 50) - (v_hj / 16) * ((15238 * v_hj) / 43) + 29;
        v_hm := (24 * v_l) / 709;
        v_hd := v_l - (709 * v_hm) / 24;
        v_hy := 30 * v_hn + v_hj - 30;
        v_hijri := v_hy || '/' || lpad(v_hm::text, 2, '0') || '/' || lpad(least(v_hd, 30)::text, 2, '0');
        PERFORM public.add_declaration(v_tx, jsonb_build_object(
          'declaration_no', 'TSTD' || lpad(v_n::text, 6, '0'),
          'declaration_type', CASE WHEN v_op = 'export' THEN 'تصدير' ELSE 'استيراد' END,
          'declaration_date', v_ddate, 'declaration_date_hijri', v_hijri, 'status', v_dstage, 'notes', c_mark));
      END IF;

      -- walk the stages up to the plan's target, one at a time (a transaction without containers may skip the transport
      -- stages, with a reason — the admin's stage-skip right); the movements are created on the way
      LOOP
        SELECT t.operational_status INTO v_cur FROM public.transactions t WHERE t.id = v_tx;
        EXIT WHEN array_position(c_order, v_cur) >= array_position(c_order, s);
        v_next := c_order[array_position(c_order, v_cur) + 1];
        IF v_ncont = 0 AND v_cur = 'customs_declaration' THEN
          v_next := CASE WHEN array_position(c_order, s) >= array_position(c_order, 'operationally_complete')
                         THEN 'operationally_complete' ELSE s END;
        END IF;

        IF v_next = 'transport' AND v_ncont > 0 THEN
          -- one movement per container (appointment + trip + return plan) = save_movement; the trip moves the stage
          FOR i IN 1 .. v_ncont LOOP
            v_trip_no := v_trip_no + 1;
            v_party := v_trip_no % 4;   -- 0 company, 1 supplier, 2 direct, 3 unset
            v_ms := CASE WHEN array_position(c_order, s) >= array_position(c_order, 'empty_return') OR (v_n + i) % 3 = 0
                         THEN 'delivered' ELSE 'registered' END;
            -- delivered: 1–2 days after the declaration date (never later than 30 h ago)
            v_at := CASE WHEN v_ms = 'delivered' THEN least((v_ddate + 1 + (v_n + i) % 2)::timestamptz + make_interval(hours => 7 + i),
                                                            date_trunc('hour', now()) - interval '30 hours')
                         WHEN (v_n + i) % 3 = 1 THEN now() - interval '20 hours'      -- passed, movement not updated: critical
                         WHEN v_n % 2 = 0 THEN now() - interval '8 hours'             -- passed: follow-up (warning)
                         ELSE date_trunc('hour', now()) + make_interval(days => 1 + i) END;
            v_ret := CASE WHEN (v_n + i) % 4 = 0 THEN current_date - (1 + v_n % 5)          -- overdue empty return
                          ELSE current_date + (2 + (v_n + i) % 9) END;
            IF v_ms = 'delivered' THEN
              v_dlv[i] := v_at + interval '3 hours';
              v_ret := greatest(v_ret, v_at::date + 1);                                     -- never before the delivery
            END IF;
            v_p := jsonb_build_object('transaction_id', v_tx, 'container_id', v_ctrs[i], 'appointment_at', v_at,
              'appointment_no', 'TAS9' || lpad((v_n * 10 + i)::text, 8, '0'), 'appointment_status', 'confirmed',
              'driver_id', v_drv[v_trip_no % 8 + 1], 'truck_id', v_trk[v_trip_no % 6 + 1],
              'origin', coalesce((SELECT p.name_ar FROM public.customs_ports p WHERE p.code = v_port), 'الميناء'),
              'destination', c_prefix || 'مستودع العميل ' || k,
              'cost_amount', 600 + (v_n * 37 + i * 11) % 900, 'sell_amount', 900 + (v_n * 41 + i * 13) % 1100,
              'notes', c_mark, 'movement_status', v_ms,
              'return_deadline', v_ret, 'return_yard_party_id', p_yard);
            IF v_term IS NOT NULL THEN v_p := v_p || jsonb_build_object('terminal_party_id', v_term); END IF;
            IF v_party = 0 THEN v_p := v_p || jsonb_build_object('carrier_id', p_car[v_trip_no % 2 + 1]); END IF;
            IF v_ms = 'delivered' THEN v_p := v_p || jsonb_build_object('delivered_at', v_dlv[i]); END IF;
            PERFORM public.save_movement(v_p, NULL);
          END LOOP;
        ELSIF v_next = 'appointment' AND v_ncont > 0 AND s = 'appointment' THEN
          -- appointment only (no trip yet): create_appointment for every container, some already passed
          PERFORM public.set_transaction_status(v_tx, 'appointment', c_mark || ' — نقل مرحلة تجريبي', NULL, true);
          FOR i IN 1 .. v_ncont LOOP
            v_p := jsonb_build_object('transaction_id', v_tx, 'container_id', v_ctrs[i],
              'appointment_at', CASE WHEN (v_n + i) % 3 = 0 THEN now() - interval '9 hours'
                                     ELSE date_trunc('hour', now()) + make_interval(days => (v_n + i) % 4, hours => 8 + i) END,
              'appointment_no', 'TAS9' || lpad((v_n * 10 + i)::text, 8, '0'),
              'status', CASE WHEN i % 2 = 0 THEN 'requested' ELSE 'confirmed' END);
            IF v_term IS NOT NULL THEN v_p := v_p || jsonb_build_object('terminal_party_id', v_term); END IF;
            PERFORM public.create_appointment(v_p, NULL);
            PERFORM public.set_container_return(v_ctrs[i], jsonb_build_object('return_deadline', current_date + 5 + i,
                                                                               'return_yard_party_id', p_yard));
          END LOOP;
          CONTINUE;
        ELSIF v_next = 'empty_return' AND v_ncont > 0 THEN
          -- returns recorded as documented waivers (an empty-return proof needs a real EIR file); in the empty_return
          -- stage at least one container stays open (deadline set by the movement, some overdue)
          FOR i IN 1 .. v_ncont LOOP
            IF s <> 'empty_return' OR i < v_ncont OR v_ncont = 1 AND v_n % 2 = 0 THEN
              -- returned a day after its delivery (never in the future)
              UPDATE public.containers c SET return_status = 'waived',
                     returned_at = least(coalesce(v_dlv[i], now() - interval '2 days') + interval '1 day', now() - interval '2 hours'),
                     waiver_reason = c_mark || ' — إرجاع تجريبي (إعفاء موثق بدل إيصال حقيقي)'
               WHERE c.id = v_ctrs[i];
            END IF;
          END LOOP;
        END IF;

        SELECT t.operational_status INTO v_cur FROM public.transactions t WHERE t.id = v_tx;
        IF array_position(c_order, v_cur) < array_position(c_order, v_next) THEN
          PERFORM public.set_transaction_status(v_tx, v_next, c_mark || ' — نقل مرحلة تجريبي', NULL, true);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- ------------------------------------------------------------------ 4. payment register (all pending / draft)
  FOR i IN 1 .. array_length(v_txs, 1) LOOP
    CONTINUE WHEN v_tx_status[i] IN ('new','cancelled');
    FOR j IN 1 .. CASE WHEN i % 3 = 0 THEN 2 ELSE 1 END LOOP
      v_pay := v_pay + 1;
      v_kind := v_pay % 6;
      v_p := jsonb_build_object('transaction_id', v_txs[i], 'paid_amount', 150 + (v_pay * 97) % 2400,
        -- between the declaration date and today (no declaration yet: today / yesterday)
        'paid_at', CASE WHEN v_tx_ddate[i] IS NULL THEN current_date - v_pay % 2
                        ELSE v_tx_ddate[i] + v_pay % (current_date - v_tx_ddate[i] + 1) END, 'notes', c_mark,
        'review_status', CASE WHEN v_pay % 4 = 0 THEN 'draft' ELSE 'pending' END);
      v_p := v_p || CASE v_kind
        WHEN 0 THEN jsonb_build_object('movement_type', 'org_paid', 'service_code', 'gate_out_appointment', 'funding_source', 'org_account',
                      'method', 'sadad', 'sadad_number', '99990' || lpad(v_pay::text, 7, '0'), 'paying_account', 'TEST-ACCOUNT-01',
                      'beneficiary_party_id', coalesce(p_op1, p_op2), 'appointment_no', 'TAS8' || lpad(v_pay::text, 8, '0'))
        WHEN 1 THEN jsonb_build_object('movement_type', 'org_paid', 'service_code', 'customs_duties', 'funding_source', 'fasah_wallet',
                      'method', 'fasah_wallet', 'receipt_no', 'TSTFSH' || lpad(v_pay::text, 6, '0'), 'beneficiary_party_id', p_customs)
        WHEN 2 THEN jsonb_build_object('movement_type', 'org_paid', 'service_code', 'storage_charges', 'funding_source', 'cash_box',
                      'method', 'cash', 'receipt_no', 'TSTCASH' || lpad(v_pay::text, 6, '0'), 'beneficiary_party_id', p_op2)
        WHEN 3 THEN jsonb_build_object('movement_type', 'org_paid', 'service_code', 'agent_fines_extension', 'funding_source', 'org_account',
                      'method', 'bank_transfer', 'bank_reference', 'TESTSEED-' || lpad(v_pay::text, 6, '0'), 'paying_account', 'TEST-ACCOUNT-01',
                      'beneficiary_party_id', p_ag[v_pay % 3 + 1], 'claim_no', 'TSTINV' || lpad(v_pay::text, 6, '0'))
        WHEN 4 THEN jsonb_build_object('movement_type', 'client_direct', 'service_code', 'electricity_charges', 'method', 'mada',
                      'receipt_no', 'TSTMADA' || lpad(v_pay::text, 6, '0'), 'paying_account', 'TEST-CLIENT-CARD', 'beneficiary_party_id', p_elec)
        ELSE        jsonb_build_object('movement_type', 'received_from_client', 'service_code', 'customs_clearance', 'method', 'bank_transfer',
                      'bank_reference', 'TESTSEEDIN-' || lpad(v_pay::text, 6, '0'), 'paying_account', 'TEST-CLIENT-ACCOUNT')
      END;
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.org_service_items si WHERE si.org_id = v_org AND si.is_active AND si.code = v_p ->> 'service_code');
      PERFORM public.record_payment_bundle(v_p, NULL);
    END LOOP;
  END LOOP;
  -- one shared (aggregated) payment over three transactions (port charges, one SADAD bill)
  SELECT array_agg(x.t ORDER BY x.o) INTO v_ctrs FROM (
    SELECT v_txs[g] t, g o FROM generate_series(1, array_length(v_txs, 1)) g
     WHERE v_tx_status[g] IN ('transport','empty_return','operationally_complete') LIMIT 3) x;
  IF cardinality(v_ctrs) = 3 AND EXISTS (SELECT 1 FROM public.org_service_items si WHERE si.org_id = v_org AND si.is_active AND si.code = 'port_charges') THEN
    PERFORM public.record_payment_bundle(jsonb_build_object('movement_type', 'org_paid', 'pattern', 'shared', 'service_code', 'port_charges',
      'paid_amount', 1350, 'paid_at', current_date - 3, 'funding_source', 'org_account', 'method', 'sadad',
      'sadad_number', '999911110001', 'paying_account', 'TEST-ACCOUNT-01', 'beneficiary_party_id', p_op1, 'notes', c_mark || ' — سداد مجمع',
      'allocations', jsonb_build_array(
        jsonb_build_object('transaction_id', v_ctrs[1], 'amount', 450, 'notes', c_mark),
        jsonb_build_object('transaction_id', v_ctrs[2], 'amount', 500, 'notes', c_mark),
        jsonb_build_object('transaction_id', v_ctrs[3], 'amount', 400, 'notes', c_mark))), NULL);
  END IF;

  -- ------------------------------------------------------------------ 5. client custody (6 clients)
  -- the custody-funded payment's service item: the first ACTIVE one of these (none active: no custody payment)
  SELECT si.code INTO v_cust_svc FROM public.org_service_items si
   WHERE si.org_id = v_org AND si.is_active AND si.code = ANY (ARRAY['port_storage_groundage','storage_charges','port_charges'])
   ORDER BY array_position(ARRAY['port_storage_groundage','storage_charges','port_charges'], si.code) LIMIT 1;
  FOR k IN 1 .. 6 LOOP
    v_cid := v_clients[k * 3 - 1];
    PERFORM public.save_custody_entry(jsonb_build_object('client_id', v_cid, 'kind', 'deposit', 'amount', 3000 + k * 500,
      'entry_date', current_date - 15 + k, 'branch_id', v_branch, 'reference', 'TSTDEP' || k, 'notes', c_mark), NULL);
    IF k % 2 = 0 THEN
      PERFORM public.save_custody_entry(jsonb_build_object('client_id', v_cid, 'kind', 'deposit', 'amount', 1000,
        'entry_date', current_date - 5, 'branch_id', v_branch, 'reference', 'TSTDEP' || k || 'B', 'notes', c_mark), NULL);
    END IF;
    -- a payment funded from the client's custody on one of its live transactions (not a new one: like the register
    -- above, new transactions get no payment) + the deduction that books it
    v_tx := NULL;
    SELECT x.t INTO v_tx FROM (SELECT v_txs[g] t, g o FROM generate_series(1, array_length(v_txs, 1)) g
                                WHERE v_tx_client[g] = v_cid AND v_tx_status[g] NOT IN ('new','cancelled','closed') ORDER BY g LIMIT 1) x;
    IF v_tx IS NOT NULL AND v_cust_svc IS NOT NULL THEN
      v_res := public.record_payment_bundle(jsonb_build_object('transaction_id', v_tx, 'movement_type', 'org_paid',
        'service_code', v_cust_svc, 'paid_amount', 400 + k * 50, 'paid_at', current_date - 1,
        'funding_source', 'client_custody', 'method', 'other', 'receipt_no', 'TSTCUS' || lpad(k::text, 4, '0'),
        'beneficiary_party_id', p_op1, 'notes', c_mark || ' — من عهدة العميل'), NULL);
      v_disb := (v_res ->> 'id')::uuid;
      PERFORM public.save_custody_entry(jsonb_build_object('client_id', v_cid, 'kind', 'deduction', 'amount', 400 + k * 50,
        'entry_date', current_date - 1, 'transaction_id', v_tx, 'disbursement_id', v_disb, 'reference', 'TSTDED' || k, 'notes', c_mark), NULL);
    END IF;
    IF k % 3 = 0 THEN
      PERFORM public.save_custody_entry(jsonb_build_object('client_id', v_cid, 'kind', 'refund', 'amount', 250 * k,
        'entry_date', current_date - 1, 'branch_id', v_branch, 'reference', 'TSTREF' || k, 'notes', c_mark), NULL);
    END IF;
  END LOOP;

  -- ------------------------------------------------------------------ 6. back to the database owner
  -- the JWT claims MUST be empty before the transaction commits: the DEFERRED trigger trg_daftra_opening (customs
  -- declarations) runs at commit and opens a Daftra draft / review item only for a request with claims
  -- (app.auto_lifecycle_on) — with no claims it does nothing, whatever daftra_connections.auto_draft_on_declaration says
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE format('SET LOCAL ROLE %I', v_orig_role);
  -- the trip party type (supplier / company / direct / unset): only an approved appointment card (a file) sets it in the
  -- app; written here on the test trips only
  UPDATE public.transport_trips r SET
    party_type = x.pt,
    party_name = CASE x.pt WHEN 'supplier' THEN (SELECT p.name_ar FROM public.parties p WHERE p.id = p_tsup)
                           WHEN 'company' THEN (SELECT p.name_ar FROM public.parties p WHERE p.id = r.carrier_id)
                           WHEN 'direct' THEN (SELECT d.full_name FROM public.drivers d WHERE d.id = r.driver_id) END
    FROM (SELECT t.id, CASE WHEN t.carrier_id IS NOT NULL THEN 'company'
                            ELSE (ARRAY['supplier','direct',NULL])[(row_number() OVER (ORDER BY t.created_at, t.id))::int % 3 + 1] END pt
            FROM public.transport_trips t WHERE t.transaction_id = ANY (v_txs)) x
   WHERE r.id = x.id AND x.pt IS NOT NULL;

  -- the stage-aging clocks of the TEST rows (last, so nothing touches them again): 1 in 3 transactions stays fresh, 1 in 3
  -- just past its status's warning hours, 1 in 3 past its critical hours (statuses without a rule are left as they are);
  -- every second open declaration is 80 h old (> 3 days: «declaration stalled»). The touch triggers stamp now() on any
  -- update, so they are off for these two statements only and then back exactly as they were.
  -- ALTER TABLE is refused while deferred trigger events are queued (trg_daftra_opening of the declarations): they are
  -- fired now — the JWT claims are already empty, so they do nothing (see above)
  SET CONSTRAINTS ALL IMMEDIATE;
  v_rules := app.status_aging_rules(v_org);
  SELECT coalesce(jsonb_agg(jsonb_build_object('t', t.tgrelid::regclass::text, 'n', t.tgname, 'e', t.tgenabled)), '[]'::jsonb) INTO v_trg
    FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgfoid = 'app.touch_updated_at'::regproc
     AND t.tgrelid IN ('public.transactions'::regclass, 'public.customs_declarations'::regclass);
  FOR i IN 0 .. jsonb_array_length(v_trg) - 1 LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', v_trg -> i ->> 't', v_trg -> i ->> 'n');
  END LOOP;
  UPDATE public.customs_declarations d SET updated_at = now() - interval '80 hours'
   WHERE d.transaction_id = ANY (v_txs) AND d.declaration_no LIKE 'TSTD%' AND d.status <> 'released'
     AND substr(d.declaration_no, 5)::int % 2 = 0;
  UPDATE public.transactions t SET updated_at = now() - make_interval(hours => CASE x.g % 3
           WHEN 1 THEN (v_rules -> t.operational_status ->> 'warning_hours')::int + 3
           ELSE (v_rules -> t.operational_status ->> 'critical_hours')::int + 6 END)
    FROM unnest(v_txs) WITH ORDINALITY x(id, g)
   WHERE t.id = x.id AND x.g % 3 <> 0 AND t.cancelled_at IS NULL
     AND jsonb_typeof(v_rules -> t.operational_status) = 'object';
  FOR i IN 0 .. jsonb_array_length(v_trg) - 1 LOOP
    EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I', v_trg -> i ->> 't',
                   CASE v_trg -> i ->> 'e' WHEN 'R' THEN 'REPLICA' WHEN 'A' THEN 'ALWAYS' ELSE '' END, v_trg -> i ->> 'n');
  END LOOP;

  RAISE NOTICE 'TEST SEED done: org %, branch %, admin %, % transactions, % payments.', v_org, v_branch, v_admin, array_length(v_txs, 1), v_pay;
END $seed$;

-- the proof: one row of counts (everything selected by the markers)
WITH o AS (SELECT id FROM public.organizations WHERE slug = 'marsa'),
c AS (SELECT cl.id FROM public.clients cl, o WHERE cl.org_id = o.id AND cl.name_ar LIKE 'تجريبي — %'),
t AS (SELECT tx.* FROM public.transactions tx WHERE tx.client_id IN (SELECT id FROM c))
SELECT (SELECT count(*) FROM c) AS clients,
       (SELECT count(*) FROM t) AS transactions,
       (SELECT jsonb_object_agg(z.st, z.n) FROM (SELECT CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE operational_status END st,
                                                        count(*) n FROM t GROUP BY 1) z) AS transactions_by_status,
       (SELECT count(*) FROM public.containers k WHERE k.transaction_id IN (SELECT id FROM t)) AS containers,
       (SELECT count(*) FROM public.customs_declarations d WHERE d.transaction_id IN (SELECT id FROM t)) AS declarations,
       (SELECT count(*) FROM public.port_appointments a WHERE a.transaction_id IN (SELECT id FROM t)) AS appointments,
       (SELECT count(*) FROM public.transport_trips r WHERE r.transaction_id IN (SELECT id FROM t)) AS trips,
       (SELECT count(DISTINCT a.disbursement_id) FROM public.disbursement_allocations a WHERE a.transaction_id IN (SELECT id FROM t)) AS payments,
       (SELECT count(*) FROM public.disbursement_allocations a WHERE a.transaction_id IN (SELECT id FROM t)) AS payment_allocations,
       (SELECT count(*) FROM public.client_custody_entries e WHERE e.client_id IN (SELECT id FROM c)) AS custody_movements;
