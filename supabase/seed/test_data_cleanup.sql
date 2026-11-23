-- =====================================================================
-- Marsa (مرسى) — TEST DATA CLEANUP for the org whose slug is 'marsa'. Removes EVERYTHING test_data_seed.sql created
-- (and whatever was added later ON the test clients / test transactions while trying the screens), nothing else.
-- NOT a migration. Paste the WHOLE file into the Supabase SQL Editor and press Run once (one transaction: any error =
-- nothing is deleted). The last statement returns one row of counts — every one must be 0.
--
-- What is "test":
--   · clients of the org whose name starts with «تجريبي — » (the roots), and every transaction of those clients;
--   · parties «تجريبي — …», drivers «تجريبي — …», trucks TST…, B/Ls TESTBL…;
--   · payment-register entries that have an allocation on a test transaction;
--   · and every row hanging off any of these through a foreign key (containers, declarations, events, appointments,
--     trips, return plans, cost accruals, payments / allocations / supplier invoices + payments booked by them, custody
--     entries, documents rows, drafts, alerts, …) — found by walking the foreign keys, so rows added later while testing
--     are included — plus their audit_log rows (audit_log has no foreign key: matched by table + row id).
-- Refuses (RAISE EXCEPTION, nothing deleted) when something that looks REAL is involved:
--   R1 a transaction with a TESTBL B/L or the TEST-SEED note whose client is NOT a «تجريبي — » client;
--   R2 a row to be deleted that points to a NON-test transaction or a NON-test client (e.g. a real transaction using a
--      test terminal operator / shipping agent, a payment shared between a test and a real transaction, a real trip with
--      a test driver) — detach it in the app first; and a row reached from a test party / driver / truck / B/L that is
--      not test data itself, also in tables without a transaction / client column (a real driver or truck of a test
--      carrier, a real supplier invoice of a test supplier, a real B/L of a test shipping agent, a real payment to a test
--      beneficiary): «test data» = a marked row (above), a row reached from a test client / transaction / payment, or a
--      row owned (NOT NULL foreign key) by such a row; the message names the table and the column;
--   R3 rows in the message / billing / Daftra tables (an e-mail thread linked to a test transaction, a billing intent,
--      a Daftra job…): real external effects may have happened. Check them; to delete them anyway run first, in the
--      same paste:  SELECT set_config('marsa.cleanup_allow_external', 'yes', true);
-- Guards: the append-only / void-only / audit triggers of the touched tables are DISABLED one by one (ALTER TABLE …
-- DISABLE TRIGGER <name>) inside this transaction and re-enabled to their previous state before it ends (on Supabase
-- the postgres role is not a superuser, so session_replication_role = replica is not available; it owns the tables,
-- so ALTER TABLE is). Foreign keys stay ON (they are internal triggers, never disabled). ALTER TABLE takes a short
-- exclusive lock on each touched table: run it at a quiet moment.
-- The only change to a non-test row: a real driver whose «last truck used» (drivers.last_truck_id, set by the movement
-- form) is a test truck gets that pointer cleared (NULL) instead of being deleted with the truck (listed in a NOTICE).
-- Not undone: the MRS-… transaction number counter (the next real numbers simply continue after the test ones).
-- The per-org PAY- / CUS- counters (org_counters scopes 'payment' / 'custody', 20261211000100) go back to the highest
-- number still used in the org once its test payments / custody entries are deleted (the counter row is removed when
-- none is left, as before the seed), so a counter row the seed created does not stay behind; never lower than a
-- number still in use, so no reference can be reused inside the org.
-- Also not undone:
-- uploaded files in Storage (rows of documents are deleted, the files are listed in a NOTICE — delete them in the
-- Storage screen). The monthly transaction usage counter is reduced by the deleted test transactions.
-- =====================================================================

DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;

CREATE TEMP TABLE IF NOT EXISTS _test_cleanup_root (tbl text NOT NULL, id uuid NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS _test_cleanup_gone (tbl text NOT NULL, id text NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS _test_cleanup_owned (tbl text NOT NULL, rid tid NOT NULL);
TRUNCATE _test_cleanup_root, _test_cleanup_gone, _test_cleanup_owned;

DO $clean$
DECLARE
  c_prefix constant text := 'تجريبي — ';
  v_org uuid; v_n bigint; v_msg text; r record; f record;
  v_nodes jsonb := '[]'::jsonb;        -- [{t: regclass text, p: predicate, d: depth}]
  v_queue jsonb; v_node jsonb; v_new jsonb; v_child text; v_pred text; v_seen text[] := '{}'; v_key text;
  v_tables text[] := '{}'; v_trg jsonb := '[]'::jsonb; v_protected text[] := '{}';
  v_allow boolean := coalesce(current_setting('marsa.cleanup_allow_external', true), '') = 'yes';
  v_files text; v_breaks jsonb := '[]'::jsonb;   -- [{t, set, p}]: FK columns nulled first to break a cycle
  c_owner_roots constant text[] := ARRAY['public.clients','public.transactions','public.client_disbursements'];
  v_ok int[] := '{}';                             -- directory-rooted nodes whose rows are all test data
BEGIN
  SELECT o.id INTO v_org FROM public.organizations o WHERE o.slug = 'marsa';
  IF v_org IS NULL THEN RAISE EXCEPTION 'TEST CLEANUP: no organization with slug ''marsa''. Nothing was changed.'; END IF;

  -- ------------------------------------------------------------------ roots (materialised before anything is deleted)
  INSERT INTO _test_cleanup_root SELECT 'clients', c.id FROM public.clients c WHERE c.org_id = v_org AND c.name_ar LIKE c_prefix || '%';
  INSERT INTO _test_cleanup_root SELECT 'transactions', t.id FROM public.transactions t
   WHERE t.org_id = v_org AND t.client_id IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'clients');
  INSERT INTO _test_cleanup_root SELECT 'parties', p.id FROM public.parties p WHERE p.org_id = v_org AND p.name_ar LIKE c_prefix || '%';
  INSERT INTO _test_cleanup_root SELECT 'drivers', d.id FROM public.drivers d WHERE d.org_id = v_org AND d.full_name LIKE c_prefix || '%';
  INSERT INTO _test_cleanup_root SELECT 'trucks', k.id FROM public.trucks k WHERE k.org_id = v_org AND k.plate_no ~ '^TST[0-9]+$';
  INSERT INTO _test_cleanup_root SELECT 'bills_of_lading', b.id FROM public.bills_of_lading b WHERE b.org_id = v_org AND b.bl_number LIKE 'TESTBL%';
  INSERT INTO _test_cleanup_root SELECT DISTINCT 'client_disbursements', a.disbursement_id FROM public.disbursement_allocations a
   WHERE a.org_id = v_org AND a.transaction_id IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'transactions');

  -- R1: a marked transaction of a client that is not a test client
  SELECT string_agg(t.ref, ', ') INTO v_msg FROM public.transactions t
   WHERE t.org_id = v_org AND (t.bl_number LIKE 'TESTBL%' OR t.notes = 'TEST-SEED')
     AND t.id NOT IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'transactions');
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION 'TEST CLEANUP refused (R1): transaction(s) % carry a test marker but their client is not a «تجريبي — » client — they may be real. Nothing was deleted.', v_msg;
  END IF;

  -- a real driver whose «last truck used» is a test truck: the pointer is cleared, the driver stays
  SELECT string_agg(d.full_name, ', ') INTO v_msg FROM public.drivers d
   WHERE d.org_id = v_org AND d.last_truck_id IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'trucks')
     AND d.id NOT IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'drivers');
  IF v_msg IS NOT NULL THEN
    UPDATE public.drivers d SET last_truck_id = NULL
     WHERE d.org_id = v_org AND d.last_truck_id IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'trucks')
       AND d.id NOT IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'drivers');
    RAISE NOTICE 'TEST CLEANUP: «last truck used» cleared (it was a test truck) on the real driver(s): %', v_msg;
  END IF;

  -- ------------------------------------------------------------------ the delete plan: walk the foreign keys
  -- node: t table, p predicate, d depth, path, i its index, pi its parent's index, root the root table, via the FK
  -- columns, own = the FK columns are NOT NULL (the row belongs to its parent)
  FOR r IN SELECT DISTINCT tbl FROM _test_cleanup_root LOOP
    v_nodes := v_nodes || jsonb_build_object('t', 'public.' || r.tbl,
      'p', format('id IN (SELECT id FROM pg_temp._test_cleanup_root WHERE tbl = %L)', r.tbl), 'd', 0,
      'path', jsonb_build_array('public.' || r.tbl), 'i', jsonb_array_length(v_nodes), 'pi', -1,
      'root', 'public.' || r.tbl, 'via', 'id', 'own', false);
  END LOOP;
  v_queue := v_nodes;
  WHILE jsonb_array_length(v_queue) > 0 LOOP
    v_node := v_queue -> 0; v_queue := v_queue - 0;
    FOR f IN
      SELECT (SELECT format('%I.%I', n.nspname, cl.relname) FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
               WHERE cl.oid = c.conrelid) AS child,
             (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.o) FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS ccols,
             (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.o) FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS pcols,
             (SELECT string_agg(format('%I = NULL', a.attname), ', ') FROM unnest(c.conkey) k(n)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
               WHERE NOT a.attnotnull AND a.attname <> 'org_id') AS nullable_set
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confrelid = (v_node ->> 't')::regclass AND c.conrelid <> c.confrelid
       ORDER BY 1, 2
    LOOP
      v_pred := format('(%s) IN (SELECT %s FROM %s WHERE %s)', f.ccols, f.pcols, v_node ->> 't', v_node ->> 'p');
      v_key := f.child || '|' || v_pred;
      CONTINUE WHEN v_key = ANY (v_seen);
      v_seen := v_seen || v_key;
      IF (v_node -> 'path') ? f.child THEN
        -- a cycle (e.g. supplier_payments ↔ disbursement_allocations): every such row is deleted anyway, so the link is
        -- cut first (the nullable FK columns set to NULL) and the walk stops here
        IF f.nullable_set IS NULL THEN RAISE EXCEPTION 'TEST CLEANUP: foreign-key cycle at % without a nullable column (nothing deleted)', f.child; END IF;
        v_breaks := v_breaks || jsonb_build_object('t', f.child, 'set', f.nullable_set, 'p', v_pred);
        CONTINUE;
      END IF;
      IF (v_node ->> 'd')::int >= 12 THEN RAISE EXCEPTION 'TEST CLEANUP: foreign-key chain too deep at % (nothing deleted)', f.child; END IF;
      EXECUTE format('SELECT count(*) FROM %s WHERE %s', f.child, v_pred) INTO v_n;
      CONTINUE WHEN v_n = 0;             -- no rows: nothing to delete there, nothing below it either
      v_new := jsonb_build_object('t', f.child, 'p', v_pred, 'd', (v_node ->> 'd')::int + 1,
                                    'path', (v_node -> 'path') || to_jsonb(f.child), 'i', jsonb_array_length(v_nodes),
                                    'pi', (v_node ->> 'i')::int, 'root', v_node ->> 'root', 'via', f.ccols,
                                    'own', f.nullable_set IS NULL);
      v_nodes := v_nodes || v_new;
      v_queue := v_queue || v_new;
    END LOOP;
  END LOOP;

  -- ------------------------------------------------------------------ what is test data (row ids = ctid, stable here)
  -- the marked rows, every row reached from a test client / transaction / payment, a test party's ports, and the
  -- message / billing / Daftra rows (R3 decides on those)
  FOR i IN 0 .. jsonb_array_length(v_nodes) - 1 LOOP
    v_node := v_nodes -> i;
    IF (v_node ->> 'd')::int = 0 OR (v_node ->> 'root') = ANY (c_owner_roots)
       OR ((v_node ->> 'd')::int = 1 AND (v_node ->> 't') = 'public.party_ports')
       OR (v_node ->> 't') ~ '^public\.(msg_|billing_|daftra_)' THEN
      EXECUTE format('INSERT INTO pg_temp._test_cleanup_owned (tbl, rid) SELECT %L, z.ctid FROM %s z WHERE %s',
                     v_node ->> 't', v_node ->> 't', v_node ->> 'p');
    END IF;
  END LOOP;

  -- ------------------------------------------------------------------ refusals R2 / R3 (before anything is deleted)
  FOR i IN 0 .. jsonb_array_length(v_nodes) - 1 LOOP
    v_node := v_nodes -> i;
    IF NOT ((v_node ->> 't') = ANY (v_tables)) THEN v_tables := v_tables || (v_node ->> 't'); END IF;
    IF (v_node ->> 't') <> 'public.transactions' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (v_node ->> 't')::regclass
                                                  AND a.attname = 'transaction_id' AND NOT a.attisdropped) THEN
      EXECUTE format('SELECT count(*) FROM %s WHERE (%s) AND transaction_id IS NOT NULL
                       AND transaction_id NOT IN (SELECT id FROM pg_temp._test_cleanup_root WHERE tbl = ''transactions'')',
                     v_node ->> 't', v_node ->> 'p') INTO v_n;
      IF v_n > 0 THEN
        RAISE EXCEPTION 'TEST CLEANUP refused (R2): % row(s) of % that would be deleted belong to a NON-test transaction (a real record uses test data). Detach them in the app first. Nothing was deleted.',
          v_n, v_node ->> 't';
      END IF;
    END IF;
    IF (v_node ->> 't') <> 'public.clients' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (v_node ->> 't')::regclass
                                                  AND a.attname = 'client_id' AND NOT a.attisdropped) THEN
      EXECUTE format('SELECT count(*) FROM %s WHERE (%s) AND client_id IS NOT NULL
                       AND client_id NOT IN (SELECT id FROM pg_temp._test_cleanup_root WHERE tbl = ''clients'')',
                     v_node ->> 't', v_node ->> 'p') INTO v_n;
      IF v_n > 0 THEN
        RAISE EXCEPTION 'TEST CLEANUP refused (R2): % row(s) of % that would be deleted belong to a NON-test client. Nothing was deleted.',
          v_n, v_node ->> 't';
      END IF;
    END IF;
    -- R2 (directory roots): every row reached from a test party / driver / truck / B/L must be test data itself — or
    -- belong (NOT NULL foreign key) to a row of such a node that was all test data (nodes come parents first)
    IF (v_node ->> 'd')::int > 0 AND NOT ((v_node ->> 'root') = ANY (c_owner_roots)) THEN
      EXECUTE format('SELECT count(*) FROM %s z WHERE (%s) AND NOT EXISTS (SELECT 1 FROM pg_temp._test_cleanup_owned o
                       WHERE o.tbl = %L AND o.rid = z.ctid)', v_node ->> 't', v_node ->> 'p', v_node ->> 't') INTO v_n;
      IF v_n > 0 AND (v_node ->> 'own')::boolean AND ((v_node ->> 'pi')::int = ANY (v_ok)) THEN
        EXECUTE format('INSERT INTO pg_temp._test_cleanup_owned (tbl, rid) SELECT %L, z.ctid FROM %s z WHERE %s',
                       v_node ->> 't', v_node ->> 't', v_node ->> 'p');
        v_n := 0;
      END IF;
      IF v_n > 0 THEN
        RAISE EXCEPTION 'TEST CLEANUP refused (R2): % row(s) of % point to test data through %.% → % but are not test data themselves (e.g. a real driver / truck of a test carrier, a real supplier invoice of a test supplier, a real B/L of a test shipping agent, a real payment to a test beneficiary). Change them in the app first. Nothing was deleted.',
          v_n, v_node ->> 't', split_part(v_node ->> 't', '.', 2), replace(replace(v_node ->> 'via', ',org_id', ''), 'org_id,', ''),
          v_nodes -> ((v_node ->> 'pi')::int) ->> 't';
      END IF;
      v_ok := v_ok || (v_node ->> 'i')::int;
    END IF;
    IF (v_node ->> 't') ~ '^public\.(msg_|billing_|daftra_)' AND NOT ((v_node ->> 't') = ANY (v_protected)) THEN
      v_protected := v_protected || (v_node ->> 't');
    END IF;
  END LOOP;
  IF cardinality(v_protected) > 0 AND NOT v_allow THEN
    RAISE EXCEPTION 'TEST CLEANUP refused (R3): test data is linked to message / billing / Daftra rows (%) — something may have been sent or pushed for real. Check them; to delete them too, run SELECT set_config(''marsa.cleanup_allow_external'', ''yes'', true); before this file in the same paste. Nothing was deleted.',
      array_to_string(v_protected, ', ');
  END IF;
  IF NOT ('public.audit_log' = ANY (v_tables)) THEN v_tables := v_tables || 'public.audit_log'::text; END IF;

  -- files in Storage are not removed by SQL: list them
  SELECT string_agg(d.storage_bucket || '/' || d.storage_path, E'\n') INTO v_files FROM public.documents d
   WHERE d.transaction_id IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'transactions');
  IF v_files IS NOT NULL THEN RAISE NOTICE 'TEST CLEANUP: delete these files in Storage yourself:%', E'\n' || v_files; END IF;

  -- the usage counter: minus the test transactions, per month they were counted in
  UPDATE public.org_usage_counters u SET value = greatest(u.value - x.n, 0), updated_at = now()
    FROM (SELECT app.g7_period(t.created_at) p, count(*) n FROM public.transactions t
           WHERE t.id IN (SELECT id FROM _test_cleanup_root WHERE tbl = 'transactions') GROUP BY 1) x
   WHERE u.org_id = v_org AND u.metric = 'transactions_month' AND u.period_start = x.p;

  -- ------------------------------------------------------------------ guards off (only the enabled user triggers)
  SELECT coalesce(jsonb_agg(jsonb_build_object('t', t.tgrelid::regclass::text, 'n', t.tgname, 'e', t.tgenabled)), '[]'::jsonb) INTO v_trg
    FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgrelid IN (SELECT x::regclass FROM unnest(v_tables) x);
  FOR i IN 0 .. jsonb_array_length(v_trg) - 1 LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', v_trg -> i ->> 't', v_trg -> i ->> 'n');
  END LOOP;

  -- ------------------------------------------------------------------ cut the cycles, then delete, deepest first
  FOR i IN 0 .. jsonb_array_length(v_breaks) - 1 LOOP
    EXECUTE format('UPDATE %s SET %s WHERE %s', v_breaks -> i ->> 't', v_breaks -> i ->> 'set', v_breaks -> i ->> 'p');
  END LOOP;
  FOR v_node IN SELECT e FROM jsonb_array_elements(v_nodes) WITH ORDINALITY x(e, o) ORDER BY (e ->> 'd')::int DESC, o DESC LOOP
    EXECUTE format('WITH d AS (DELETE FROM %s AS z WHERE %s RETURNING to_jsonb(z) ->> ''id'' AS id)
                    INSERT INTO pg_temp._test_cleanup_gone (tbl, id) SELECT %L, d.id FROM d WHERE d.id IS NOT NULL',
                   v_node ->> 't', v_node ->> 'p', split_part(v_node ->> 't', '.', 2));
  END LOOP;
  -- their audit trail (append-only: its guard is off too)
  DELETE FROM public.audit_log l USING _test_cleanup_gone g WHERE l.table_name = g.tbl AND l.row_id = g.id;
  -- rows without an id column (e.g. transaction_bls): their audit rows carry the transaction id in the data
  DELETE FROM public.audit_log l
   WHERE l.org_id = v_org AND l.row_id IS NULL
     AND l.table_name IN (SELECT split_part(x, '.', 2) FROM unnest(v_tables) x)
     AND coalesce(l.new_data, l.old_data) ->> 'transaction_id' IN (SELECT id::text FROM _test_cleanup_root WHERE tbl = 'transactions');

  -- the per-org PAY- / CUS- counters (20261211000100; skipped before it): back to the highest number still in use in the
  -- org (row removed when none is left), only for a table whose test rows were deleted here
  IF to_regprocedure('app.next_org_seq(uuid, text)') IS NOT NULL THEN
    FOR r IN SELECT x.scope, x.tbl FROM (VALUES ('payment', 'client_disbursements'), ('custody', 'client_custody_entries')) x(scope, tbl)
              WHERE EXISTS (SELECT 1 FROM _test_cleanup_gone g WHERE g.tbl = x.tbl) LOOP
      EXECUTE format('SELECT max(z.seq) FROM public.%I z WHERE z.org_id = $1', r.tbl) INTO v_n USING v_org;
      IF v_n IS NULL THEN
        DELETE FROM public.org_counters c WHERE c.org_id = v_org AND c.scope = r.scope AND c.year = 0;
      ELSE
        UPDATE public.org_counters c SET last_value = v_n
         WHERE c.org_id = v_org AND c.scope = r.scope AND c.year = 0 AND c.last_value > v_n;
      END IF;
    END LOOP;
  END IF;

  -- ------------------------------------------------------------------ guards back on, exactly as they were
  FOR i IN 0 .. jsonb_array_length(v_trg) - 1 LOOP
    EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I', v_trg -> i ->> 't',
                   CASE v_trg -> i ->> 'e' WHEN 'R' THEN 'REPLICA' WHEN 'A' THEN 'ALWAYS' ELSE '' END, v_trg -> i ->> 'n');
  END LOOP;

  SELECT count(*) INTO v_n FROM _test_cleanup_gone;
  RAISE NOTICE 'TEST CLEANUP done: % rows removed (+ their audit rows) from % tables.', v_n, cardinality(v_tables) - 1;
END $clean$;

-- the proof: every count must be 0
WITH o AS (SELECT id FROM public.organizations WHERE slug = 'marsa')
SELECT (SELECT count(*) FROM public.clients c, o WHERE c.org_id = o.id AND c.name_ar LIKE 'تجريبي — %') AS test_clients,
       (SELECT count(*) FROM public.transactions t, o WHERE t.org_id = o.id AND (t.bl_number LIKE 'TESTBL%' OR t.notes = 'TEST-SEED')) AS test_transactions,
       (SELECT count(*) FROM public.bills_of_lading b, o WHERE b.org_id = o.id AND b.bl_number LIKE 'TESTBL%') AS test_bls,
       (SELECT count(*) FROM public.containers k, o WHERE k.org_id = o.id AND k.container_no LIKE 'TSTU%') AS test_containers,
       (SELECT count(*) FROM public.customs_declarations d, o WHERE d.org_id = o.id AND d.declaration_no LIKE 'TSTD%') AS test_declarations,
       (SELECT count(*) FROM public.parties p, o WHERE p.org_id = o.id AND p.name_ar LIKE 'تجريبي — %') AS test_parties,
       (SELECT count(*) FROM public.drivers d, o WHERE d.org_id = o.id AND d.full_name LIKE 'تجريبي — %') AS test_drivers,
       (SELECT count(*) FROM public.trucks k, o WHERE k.org_id = o.id AND k.plate_no ~ '^TST[0-9]+$') AS test_trucks,
       (SELECT count(*) FROM public.client_disbursements x, o WHERE x.org_id = o.id AND x.notes LIKE 'TEST-SEED%') AS test_payments,
       (SELECT count(*) FROM public.client_custody_entries e, o WHERE e.org_id = o.id AND e.notes LIKE 'TEST-SEED%') AS test_custody,
       (SELECT count(*) FROM public.audit_log l WHERE (l.table_name, l.row_id) IN (SELECT g.tbl, g.id FROM pg_temp._test_cleanup_gone g)
           OR (l.row_id IS NULL AND coalesce(l.new_data, l.old_data) ->> 'transaction_id' IN (SELECT r.id::text FROM pg_temp._test_cleanup_root r WHERE r.tbl = 'transactions'))) AS test_audit_rows,
       (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'D'
           AND t.tgrelid IN ('public.audit_log'::regclass, 'public.transaction_events'::regclass, 'public.client_disbursements'::regclass, 'public.containers'::regclass, 'public.transactions'::regclass)) AS guards_left_disabled;
