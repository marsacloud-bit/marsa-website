-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261103000100 — G3 migration A: registry
-- (docs/online/G3_SPEC.md items 1–6).
--
-- 1. parties (operational counterparties: shipping agents, terminals,
--    carriers, yards, brokers, suppliers) + drivers + trucks. Staff read,
--    transport writers write directly (RLS); no DELETE (deactivate instead).
-- 2. client_aliases + app.norm_name() + match_client(p_org, p_payload):
--    ranked candidates strong (VAT / CR) > alias (alias / normalized name) >
--    weak (token similarity), with reasons and a conflict flag. Read-only:
--    it never links anything.
-- 3. customs_declarations + add_declaration / set_declaration_status /
--    cancel_declaration / correct_declaration. A trigger mirrors the latest
--    ACTIVE declaration into transactions.declaration_no/date/type. A cancelled
--    number is reusable only through an explicit replacement in the same
--    transaction (cancel_declaration p_replacement, or add_declaration
--    replaces_id).
-- 4. bills_of_lading + transaction_bls (many-to-many) + save_bl / link_bl /
--    unlink_bl. transactions.bl_number mirrors the PRIMARY B/L. B/Ls are
--    branch-scoped through the transactions they feed (app.can_read_bl): staff
--    read a B/L linked to a transaction they may read; a not-yet-linked B/L is
--    read by the org's ops writers. A client reads a B/L only while every
--    transaction it feeds belongs to that client.
-- 5. containers: bl_id (must be one of the transaction's B/Ls — composite FK
--    to transaction_bls), seal_no, size_type, gross_weight_kg,
--    operational_state, visit_ref (<container_no>@<transaction ref>, kept by a
--    trigger). container_history(p_org, p_container_no) lists every visit the
--    caller may read. A number repeating across transactions stays allowed.
-- 6. transaction_completeness(p_tx) — data + documents. Migration B
--    (20261103000200) recreates it to add document_requirements.
--
-- Legacy writes stay compatible: transactions.declaration_no / bl_number are
-- still writable (convert_request_to_transaction, seed, older clients).
-- Such a write is ADOPTED into the new tables: a declaration is added when the
-- transaction has none (a cancelled number is refused); renumbering or clearing
-- an active declaration is refused (correct_declaration / cancel_declaration).
-- A B/L number is found-or-created and linked as primary (the previous primary
-- stays linked as secondary); an org B/L that already feeds another client's or
-- another branch's transaction is NOT reused — the transaction keeps the plain
-- number and a 'conflict' bl event asks staff to decide (save_bl / link_bl).
-- The mirror writes
-- back with the transaction-local flag marsa.g3_mirror = on, so the two
-- directions never loop. Existing values are backfilled the same way.
--
-- Client portal: declaration number + status, B/L numbers, containers
-- (operational_state / return status / deadline). Internal notes and cancel
-- reasons are excluded from the API SELECT grant (staff read them through
-- staff_internal_fields, extended below). Parties / drivers / trucks / aliases
-- are staff-only.
--
-- New transaction_events types: declaration, bl, container (this file) and
-- appointment, trip, exception, docs_override (reserved for migration B).
-- Errors: existing codes only (duplicates = MRS_INVALID '<field>_taken').
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- Preflight (section P, read-only, before any DDL): legacy declaration numbers
-- that collide once normalized (case / spaces / Arabic-Indic digits) stop the
-- file with the refs and numbers to fix first. Same query for a staging
-- pre-check: see the DO block below.
-- NOTE: cancel_declaration and transaction_completeness are final in migration B
-- (20261103000200). Re-running THIS file alone after B keeps B's versions (they
-- are created here only while B is not applied).
-- =====================================================================

-- ---------------------------------------------------------------------
-- P. preflight: legacy transactions.declaration_no values that become equal after
--    normalization (app.norm_code is created below; same expression inline) would make
--    the backfill fail with a bare MRS_INVALID. Report them all, change nothing.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE v_list text;
BEGIN
  SELECT string_agg(x.refs, ' | ' ORDER BY x.n) INTO v_list
    FROM (SELECT nullif(upper(regexp_replace(app.to_western(t.declaration_no), '[[:space:]]+', '', 'g')), '') AS n,
                 string_agg(t.ref || ' = ' || t.declaration_no, ', ' ORDER BY t.ref) AS refs
            FROM public.transactions t
           WHERE t.declaration_no IS NOT NULL
           GROUP BY t.org_id, 1 HAVING count(*) > 1) x;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'G3 preflight: declaration numbers collide after normalization: %', v_list
      USING HINT = 'Clear or correct one number of each group on the transaction record, then apply this file again.';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261103000100', 'g3_registry')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries + event types
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('party_kind','shipping_agent',1,'وكيل ملاحي','Shipping agent',false),
  ('party_kind','terminal_operator',2,'مشغل محطة','Terminal operator',false),
  ('party_kind','carrier',3,'ناقل','Carrier',false),
  ('party_kind','yard',4,'ساحة حاويات','Container yard',false),
  ('party_kind','customs_broker',5,'مخلص جمركي','Customs broker',false),
  ('party_kind','supplier',6,'مورد','Supplier',false),
  ('party_kind','other',7,'أخرى','Other',false),
  ('alias_source','bl',1,'من بوليصة الشحن','From bill of lading',false),
  ('alias_source','invoice',2,'من الفاتورة','From invoice',false),
  ('alias_source','manual',3,'إدخال يدوي','Manual',false),
  ('alias_source','ocr',4,'من قراءة المستند (OCR)','From OCR',false),
  ('client_match','strong',1,'تطابق قوي (رقم ضريبي / سجل تجاري)','Strong match (VAT / CR)',false),
  ('client_match','alias',2,'تطابق بالاسم أو الاسم البديل','Name / alias match',false),
  ('client_match','weak',3,'تشابه في الاسم فقط','Similar name only',false),
  ('declaration_status','draft',1,'مسودة','Draft',true),
  ('declaration_status','submitted',2,'مقدَّم','Submitted',true),
  ('declaration_status','under_inspection',3,'تحت المعاينة','Under inspection',true),
  ('declaration_status','released',4,'مفسوح','Released',true),
  ('declaration_status','cancelled',5,'ملغى','Cancelled',true),
  ('declaration_status','replaced',6,'مستبدل ببيان آخر','Replaced',true),
  ('declaration_source','manual',1,'إدخال يدوي','Manual',false),
  ('declaration_source','ocr',2,'من قراءة المستند (OCR)','From OCR',false),
  ('declaration_source','import',3,'رفع جماعي','Bulk import',false),
  ('declaration_source','fasah',4,'منصة فسح','FASAH',false),
  ('bl_type','master',1,'بوليصة رئيسية (Master)','Master B/L',true),
  ('bl_type','house',2,'بوليصة فرعية (House)','House B/L',true),
  ('bl_type','sea_waybill',3,'بوليصة بحرية غير قابلة للتداول (Sea Waybill)','Sea waybill',true),
  ('bl_type','awb',4,'بوليصة شحن جوي (AWB)','Air waybill',true),
  ('bl_type','other',5,'أخرى','Other',true),
  ('container_state','expected',1,'متوقعة','Expected',true),
  ('container_state','at_port',2,'في الميناء','At port',true),
  ('container_state','released',3,'مفسوحة','Released',true),
  ('container_state','gated_out',4,'خرجت من الميناء','Gated out',true),
  ('container_state','delivered',5,'سُلِّمت للعميل','Delivered',true),
  ('container_state','empty_returned',6,'أُعيدت فارغة','Empty returned',true)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- the inline CHECK from 0200 keeps its default name; recreate it as a superset
ALTER TABLE public.transaction_events DROP CONSTRAINT IF EXISTS transaction_events_event_type_check;
ALTER TABLE public.transaction_events ADD CONSTRAINT transaction_events_event_type_check CHECK (event_type IN
  ('created','request_converted','operational_status','financial_status','container_return','document','note','tracking_token',
   -- G3 (A): declarations, B/L links, container operational state
   'declaration','bl','container',
   -- G3 (B): appointments, transport trips, operational exceptions, document-requirement overrides
   'appointment','trip','exception','docs_override'));

-- ---------------------------------------------------------------------
-- 1. small helpers
-- ---------------------------------------------------------------------
-- identifiers (declaration / B/L / seal / plate): western digits, upper case, no whitespace
CREATE OR REPLACE FUNCTION app.norm_code(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(upper(regexp_replace(app.to_western(coalesce(p, '')), '[[:space:]]+', '', 'g')), '')
$$;

-- optional YYYY-MM-DD field from a payload (MRS_INVALID <k> when malformed)
CREATE OR REPLACE FUNCTION app.pdate(p jsonb, k text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE s text := nullif(btrim(app.to_western(coalesce(p ->> k, ''))), '');
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'string' OR s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  BEGIN
    RETURN s::date;
  EXCEPTION WHEN others THEN
    PERFORM app.fail('MRS_INVALID', k);
  END;
  RETURN NULL;
END $$;

-- G3.2 name normalization for client identity:
-- lower case, western digits, Arabic letter variants folded (أإآٱ→ا، ة→ه، ى→ي),
-- diacritics / tatweel removed, punctuation → space, company suffixes dropped.
-- Letters are matched by explicit ranges (a-z, U+0621–U+064A) so the result
-- does not depend on the database locale.
CREATE OR REPLACE FUNCTION app.norm_name(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  v := lower(app.to_western(p));
  v := regexp_replace(v, '[ً-ٰٟـ]', '', 'g');
  v := translate(v, 'أإآٱةى', 'ااااهي');
  v := regexp_replace(v, '[^0-9a-zء-ي]+', ' ', 'g');
  SELECT string_agg(u.t, ' ' ORDER BY u.o) INTO v
    FROM unnest(string_to_array(btrim(v), ' ')) WITH ORDINALITY AS u(t, o)
   WHERE u.t <> '' AND NOT (u.t = ANY (ARRAY['co','ltd','llc','est','inc','company','limited','مؤسسه','شركه']));
  RETURN nullif(v, '');
END $$;

-- token similarity of two normalized names (Jaccard over tokens of ≥ 2 characters), 0–1
CREATE OR REPLACE FUNCTION app.name_sim(a text, b text) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  WITH x AS (SELECT DISTINCT t FROM unnest(string_to_array(coalesce(a, ''), ' ')) t WHERE char_length(t) >= 2),
       y AS (SELECT DISTINCT t FROM unnest(string_to_array(coalesce(b, ''), ' ')) t WHERE char_length(t) >= 2),
       u AS (SELECT t FROM x UNION SELECT t FROM y)
  SELECT CASE WHEN (SELECT count(*) FROM u) = 0 THEN 0::numeric
              ELSE round((SELECT count(*) FROM x JOIN y USING (t))::numeric / (SELECT count(*) FROM u), 2) END
$$;

-- mirror direction flag (transaction-local): the transactions trigger that adopts
-- legacy writes ignores the updates the mirror itself makes
CREATE OR REPLACE FUNCTION app.g3_mirroring() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(current_setting('marsa.g3_mirror', true), '') = 'on'
$$;

-- lock a transaction for a write: invisible → MRS_NOT_FOUND, visible but wrong role → MRS_FORBIDDEN
CREATE OR REPLACE FUNCTION app.g3_lock_tx(p_tx uuid, p_roles text[]) RETURNS public.transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.transactions;
BEGIN
  SELECT * INTO v FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v.id IS NULL OR NOT app.has_tx_role(v.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_branch_role(v.org_id, v.branch_id, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------
-- 2. parties / drivers / trucks (G3 item 1)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parties (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kinds      text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 7 AND kinds <@ ARRAY['shipping_agent','terminal_operator',
               'carrier','yard','customs_broker','supplier','other']::text[]),
  name_ar    text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 160),
  name_en    text CHECK (char_length(name_en) <= 160),
  cr_number  text CHECK (cr_number ~ '^[0-9]{10}$'),
  vat_number text CHECK (vat_number ~ '^[0-9]{15}$'),
  phone      text CHECK (phone ~ '^\+?[0-9]{5,15}$'),
  email      text CHECK (char_length(email) <= 160 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  notes      text CHECK (char_length(notes) <= 2000),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.parties IS 'G3.1 directory of operational counterparties (one party may have several kinds). G4 extends it with supplier/finance data.';
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_name_uidx ON public.parties (org_id, lower(name_ar));
CREATE INDEX IF NOT EXISTS parties_org_kinds_idx ON public.parties USING gin (kinds);

CREATE TABLE IF NOT EXISTS public.drivers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  carrier_id        uuid,                                   -- NULL = the organization's own fleet
  full_name         text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  phone             text CHECK (phone ~ '^\+?[0-9]{5,15}$'),
  national_id_last4 text CHECK (national_id_last4 ~ '^[0-9]{4}$'),   -- last 4 digits only, never the full ID
  license_no        text CHECK (char_length(license_no) <= 30),
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drivers_carrier_fk FOREIGN KEY (carrier_id, org_id) REFERENCES public.parties(id, org_id),
  UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS drivers_carrier_idx ON public.drivers (org_id, carrier_id);

CREATE TABLE IF NOT EXISTS public.trucks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  carrier_id uuid,                                          -- NULL = the organization's own fleet
  plate_no   text NOT NULL CHECK (char_length(plate_no) BETWEEN 2 AND 20 AND plate_no !~ '[[:space:]]'),
  plate_type text CHECK (char_length(plate_type) <= 30),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trucks_carrier_fk FOREIGN KEY (carrier_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT trucks_org_plate_uniq UNIQUE (org_id, plate_no),
  UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS trucks_carrier_idx ON public.trucks (org_id, carrier_id);

-- normalization + carrier-kind rule (no caller identity needed → definer, sees the parent party)
CREATE OR REPLACE FUNCTION app.tg_parties_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.kinds := (SELECT coalesce(array_agg(DISTINCT k ORDER BY k), '{}') FROM unnest(NEW.kinds) k WHERE k IS NOT NULL);
  NEW.name_ar := btrim(NEW.name_ar);
  NEW.name_en := nullif(btrim(coalesce(NEW.name_en, '')), '');
  NEW.cr_number := app.digits(NEW.cr_number);
  NEW.vat_number := app.digits(NEW.vat_number);
  NEW.phone := nullif(regexp_replace(app.to_western(coalesce(NEW.phone, '')), '[[:space:]().-]', '', 'g'), '');
  NEW.email := nullif(lower(btrim(coalesce(NEW.email, ''))), '');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.tg_fleet_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.carrier_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.parties p WHERE p.id = NEW.carrier_id AND p.org_id = NEW.org_id AND 'carrier' = ANY (p.kinds)) THEN
    PERFORM app.fail('MRS_INVALID', 'carrier_id');
  END IF;
  IF TG_TABLE_NAME = 'drivers' THEN
    NEW.full_name := btrim(NEW.full_name);
    NEW.phone := nullif(regexp_replace(app.to_western(coalesce(NEW.phone, '')), '[[:space:]().-]', '', 'g'), '');
    NEW.national_id_last4 := nullif(btrim(app.to_western(coalesce(NEW.national_id_last4, ''))), '');
    NEW.license_no := nullif(btrim(coalesce(NEW.license_no, '')), '');
  ELSE
    -- 'ABC 1234' / 'abc-1234' / Arabic-Indic digits → one spelling, so the per-org unique plate holds
    NEW.plate_no := app.norm_code(replace(translate(NEW.plate_no, 'أإآ', 'ااا'), '-', ''));
    NEW.plate_type := nullif(btrim(coalesce(NEW.plate_type, '')), '');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_norm ON public.parties;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.parties FOR EACH ROW EXECUTE FUNCTION app.tg_parties_before();
DROP TRIGGER IF EXISTS trg_norm ON public.drivers;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION app.tg_fleet_before();
DROP TRIGGER IF EXISTS trg_norm ON public.trucks;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.trucks FOR EACH ROW EXECUTE FUNCTION app.tg_fleet_before();

-- ---------------------------------------------------------------------
-- 3. client aliases (G3.2)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id  uuid NOT NULL,
  alias      text NOT NULL CHECK (char_length(alias) BETWEEN 2 AND 160),
  alias_norm text NOT NULL CHECK (char_length(alias_norm) BETWEEN 1 AND 160),
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('bl','invoice','manual','ocr')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_aliases_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT client_aliases_norm_uniq UNIQUE (org_id, alias_norm)
);
COMMENT ON TABLE public.client_aliases IS 'G3.2 other spellings of a client name (B/L, invoice, OCR). Used by match_client(); never links anything by itself.';
CREATE INDEX IF NOT EXISTS client_aliases_client_idx ON public.client_aliases (client_id);

CREATE OR REPLACE FUNCTION app.tg_client_aliases_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.alias := btrim(NEW.alias);
  NEW.alias_norm := app.norm_name(NEW.alias);           -- always server-computed
  IF NEW.alias_norm IS NULL THEN PERFORM app.fail('MRS_INVALID', 'alias'); END IF;
  IF EXISTS (SELECT 1 FROM public.client_aliases a
              WHERE a.org_id = NEW.org_id AND a.alias_norm = NEW.alias_norm AND a.id <> NEW.id) THEN
    PERFORM app.fail('MRS_INVALID', 'alias_taken');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.client_aliases;
CREATE TRIGGER trg_norm BEFORE INSERT ON public.client_aliases FOR EACH ROW EXECUTE FUNCTION app.tg_client_aliases_before();

-- match_client(p_org, {name, name_en?, vat_number, cr_number}) — ranked candidates, never links.
-- strong = same VAT or CR; alias = alias or normalized name equal; weak = token similarity ≥ 0.34.
-- conflict = more than one client at strong/alias level, or a strong hit whose other number differs.
CREATE OR REPLACE FUNCTION public.match_client(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text; v_name_en text; v_vat text; v_cr text;
  v_out jsonb; v_conflict boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_name := app.norm_name(app.ptext(p_payload, 'name', 160));
  v_name_en := app.norm_name(app.ptext(p_payload, 'name_en', 160));
  v_vat := app.digits(app.ptext(p_payload, 'vat_number', 30));
  v_cr := app.digits(app.ptext(p_payload, 'cr_number', 30));
  IF v_name IS NULL AND v_name_en IS NULL AND v_vat IS NULL AND v_cr IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'name'); END IF;

  WITH sc AS (
    SELECT c.id, c.name_ar, c.name_en, c.cr_number, c.vat_number, c.is_active,
           coalesce(v_vat IS NOT NULL AND c.vat_number = v_vat, false) AS vat_hit,
           coalesce(v_cr IS NOT NULL AND c.cr_number = v_cr, false) AS cr_hit,
           coalesce(v_vat IS NOT NULL AND c.vat_number IS NOT NULL AND c.vat_number <> v_vat, false) AS vat_diff,
           coalesce(v_cr IS NOT NULL AND c.cr_number IS NOT NULL AND c.cr_number <> v_cr, false) AS cr_diff,
           EXISTS (SELECT 1 FROM public.client_aliases a WHERE a.client_id = c.id
                      AND (a.alias_norm = v_name OR a.alias_norm = v_name_en)) AS alias_hit,
           coalesce(app.norm_name(c.name_ar) IN (v_name, v_name_en), false)
             OR coalesce(app.norm_name(c.name_en) IN (v_name, v_name_en), false) AS name_hit,
           greatest(app.name_sim(v_name, app.norm_name(c.name_ar)), app.name_sim(v_name, app.norm_name(c.name_en)),
                    app.name_sim(v_name_en, app.norm_name(c.name_ar)), app.name_sim(v_name_en, app.norm_name(c.name_en)),
                    (SELECT max(greatest(app.name_sim(v_name, a.alias_norm), app.name_sim(v_name_en, a.alias_norm)))
                       FROM public.client_aliases a WHERE a.client_id = c.id)) AS sim
      FROM public.clients c
     WHERE c.org_id = p_org),
  m AS (
    SELECT sc.*,
           CASE WHEN vat_hit OR cr_hit THEN 'strong' WHEN alias_hit OR name_hit THEN 'alias'
                WHEN sim >= 0.34 THEN 'weak' END AS match,
           CASE WHEN vat_hit OR cr_hit THEN 3 WHEN alias_hit OR name_hit THEN 2 ELSE 1 END AS rank
      FROM sc),
  r AS (SELECT * FROM m WHERE match IS NOT NULL ORDER BY rank DESC, sim DESC, name_ar LIMIT 20)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'client_id', r.id, 'name_ar', r.name_ar, 'name_en', r.name_en, 'cr_number', r.cr_number,
           'vat_number', r.vat_number, 'is_active', r.is_active, 'match', r.match, 'rank', r.rank, 'score', r.sim,
           'reasons', to_jsonb(array_remove(ARRAY[
              CASE WHEN r.vat_hit THEN 'vat_number' END, CASE WHEN r.cr_hit THEN 'cr_number' END,
              CASE WHEN r.alias_hit THEN 'alias' END, CASE WHEN r.name_hit THEN 'name' END,
              CASE WHEN r.match = 'weak' THEN 'similar_name' END,
              CASE WHEN r.vat_diff THEN 'vat_differs' END, CASE WHEN r.cr_diff THEN 'cr_differs' END], NULL)))
           ORDER BY r.rank DESC, r.sim DESC, r.name_ar), '[]'::jsonb),
         (count(*) FILTER (WHERE r.rank >= 2) > 1)
           OR bool_or(r.rank = 3 AND (r.vat_diff OR r.cr_diff)) IS TRUE
    INTO v_out, v_conflict
    FROM r;

  RETURN jsonb_build_object('candidates', v_out, 'conflict', coalesce(v_conflict, false), 'linked', false);
END $$;

-- ---------------------------------------------------------------------
-- 4. customs declarations (G3.5)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customs_declarations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  transaction_id     uuid NOT NULL,
  declaration_no     text NOT NULL CHECK (char_length(declaration_no) BETWEEN 1 AND 30
                       AND declaration_no = upper(declaration_no) AND declaration_no !~ '[[:space:]]'),
  declaration_type   text CHECK (char_length(declaration_type) <= 40),
  declaration_date   date,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN
                       ('draft','submitted','under_inspection','released','cancelled','replaced')),
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ocr','import','fasah')),
  source_document_id uuid,
  corrected_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text CHECK (char_length(cancel_reason) <= 500),
  replaced_by_id     uuid,
  notes              text CHECK (char_length(notes) <= 2000),
  created_by         uuid,
  -- clock time: a cancel + replacement inside one call still orders correctly ("latest active")
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customs_declarations_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT customs_declarations_doc_fk FOREIGN KEY (source_document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT customs_declarations_cancel_chk CHECK (
    status NOT IN ('cancelled','replaced') OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CONSTRAINT customs_declarations_replaced_chk CHECK ((status = 'replaced') = (replaced_by_id IS NOT NULL)),
  UNIQUE (id, org_id)
);
ALTER TABLE public.customs_declarations DROP CONSTRAINT IF EXISTS customs_declarations_replaced_fk;
ALTER TABLE public.customs_declarations ADD CONSTRAINT customs_declarations_replaced_fk
  FOREIGN KEY (replaced_by_id, org_id) REFERENCES public.customs_declarations(id, org_id);
COMMENT ON TABLE public.customs_declarations IS 'G3.5 customs declarations per transaction (history kept: cancel / replace / correct). transactions.declaration_no/date/type mirror the latest active one.';
-- one active holder of a number per org; cancelled / replaced rows keep theirs as history
CREATE UNIQUE INDEX IF NOT EXISTS customs_declarations_active_no_uidx
  ON public.customs_declarations (org_id, declaration_no) WHERE status NOT IN ('cancelled','replaced');
CREATE INDEX IF NOT EXISTS customs_declarations_tx_idx ON public.customs_declarations (transaction_id, created_at);
CREATE INDEX IF NOT EXISTS customs_declarations_no_idx ON public.customs_declarations (org_id, declaration_no);

-- payload → normalized fields (only keys present in p). Errors never echo the value.
CREATE OR REPLACE FUNCTION app.decl_fields(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; s text;
BEGIN
  IF p ? 'declaration_no' THEN
    s := app.norm_code(app.ptext(p, 'declaration_no', 60, true));
    IF char_length(s) > 30 THEN PERFORM app.fail('MRS_TOO_LONG', 'declaration_no'); END IF;
    v := v || jsonb_build_object('declaration_no', s);
  END IF;
  IF p ? 'declaration_type' THEN v := v || jsonb_build_object('declaration_type', app.ptext(p, 'declaration_type', 40)); END IF;
  IF p ? 'declaration_date' THEN v := v || jsonb_build_object('declaration_date', app.pdate(p, 'declaration_date')); END IF;
  IF p ? 'notes' THEN v := v || jsonb_build_object('notes', app.ptext(p, 'notes', 2000)); END IF;
  IF p ? 'source_document_id' THEN v := v || jsonb_build_object('source_document_id', app.puuid(p, 'source_document_id')); END IF;
  IF p ? 'status' THEN
    s := app.ptext(p, 'status', 30);
    IF s IS NULL OR s NOT IN ('draft','submitted','under_inspection','released') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    v := v || jsonb_build_object('status', s);
  END IF;
  IF p ? 'source' THEN
    s := app.ptext(p, 'source', 20);
    IF s IS NULL OR s NOT IN ('manual','ocr','import','fasah') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
    v := v || jsonb_build_object('source', s);
  END IF;
  RETURN v;
END $$;

-- number rules: one active holder per org; a cancelled / replaced number comes back only
-- as an explicit replacement inside the SAME transaction (p_allow_same_tx)
CREATE OR REPLACE FUNCTION app.decl_no_check(p_org uuid, p_tx uuid, p_no text, p_exclude uuid, p_allow_same_tx boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.customs_declarations d
              WHERE d.org_id = p_org AND d.declaration_no = p_no AND d.status NOT IN ('cancelled','replaced')
                AND d.id IS DISTINCT FROM p_exclude) THEN
    PERFORM app.fail('MRS_INVALID', 'declaration_no_taken');
  END IF;
  IF EXISTS (SELECT 1 FROM public.customs_declarations d
              WHERE d.org_id = p_org AND d.declaration_no = p_no AND d.status IN ('cancelled','replaced')
                AND d.id IS DISTINCT FROM p_exclude AND (NOT p_allow_same_tx OR d.transaction_id <> p_tx)) THEN
    PERFORM app.fail('MRS_INVALID', 'declaration_no_cancelled');
  END IF;
  -- legacy rows of another transaction that still carry the number (always mirrored after this migration)
  IF EXISTS (SELECT 1 FROM public.transactions t WHERE t.org_id = p_org AND t.declaration_no = p_no AND t.id <> p_tx) THEN
    PERFORM app.fail('MRS_INVALID', 'declaration_no_taken');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.decl_json(d public.customs_declarations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', d.id, 'org_id', d.org_id, 'transaction_id', d.transaction_id,
    'declaration_no', d.declaration_no, 'declaration_type', d.declaration_type, 'declaration_date', d.declaration_date,
    'status', d.status, 'source', d.source, 'source_document_id', d.source_document_id, 'corrected_at', d.corrected_at,
    'cancelled_at', d.cancelled_at, 'cancel_reason', d.cancel_reason, 'replaced_by_id', d.replaced_by_id,
    'notes', d.notes, 'created_by', d.created_by, 'created_at', d.created_at, 'updated_at', d.updated_at)
$$;

CREATE OR REPLACE FUNCTION app.decl_event(d public.customs_declarations, p_op text, p_from text, p_note text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  -- declaration events are internal (clients read the declaration row itself: number + status)
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor, payload)
  VALUES (d.org_id, d.transaction_id, 'declaration', p_from, d.status, left(p_note, 2000), false, auth.uid(),
          jsonb_build_object('op', p_op, 'declaration_id', d.id, 'declaration_no', d.declaration_no) || coalesce(p_extra, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- new declaration row on p_tx from a payload (shared by add / cancel+replace)
CREATE OR REPLACE FUNCTION app.decl_insert(p_tx public.transactions, p jsonb, p_allow_same_tx boolean)
RETURNS public.customs_declarations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_f jsonb; v_d public.customs_declarations; v_doc uuid;
BEGIN
  PERFORM app.only_keys(p, ARRAY['declaration_no','declaration_type','declaration_date','status','source',
                                 'source_document_id','notes']);
  v_f := app.decl_fields(p);
  IF v_f ->> 'declaration_no' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_no'); END IF;
  v_doc := (v_f ->> 'source_document_id')::uuid;
  IF v_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.documents d
       WHERE d.id = v_doc AND d.transaction_id = p_tx.id AND d.voided_at IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', 'source_document_id');
  END IF;
  PERFORM app.decl_no_check(p_tx.org_id, p_tx.id, v_f ->> 'declaration_no', NULL, p_allow_same_tx);
  INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, declaration_type, declaration_date,
                                           status, source, source_document_id, notes, created_by)
  VALUES (p_tx.org_id, p_tx.id, v_f ->> 'declaration_no', v_f ->> 'declaration_type', (v_f ->> 'declaration_date')::date,
          coalesce(v_f ->> 'status', 'submitted'), coalesce(v_f ->> 'source', 'manual'), v_doc, v_f ->> 'notes', auth.uid())
  RETURNING * INTO v_d;
  PERFORM app.decl_event(v_d, 'added', NULL, NULL, jsonb_build_object('source', v_d.source));
  RETURN v_d;
END $$;

-- mirror: transactions.declaration_no/date/type = latest ACTIVE declaration (or NULL)
CREATE OR REPLACE FUNCTION app.sync_tx_declaration(p_tx uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.customs_declarations; v_prev text := coalesce(current_setting('marsa.g3_mirror', true), '');
BEGIN
  SELECT * INTO v FROM public.customs_declarations d
   WHERE d.transaction_id = p_tx AND d.status NOT IN ('cancelled','replaced')
   ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
  PERFORM set_config('marsa.g3_mirror', 'on', true);
  UPDATE public.transactions t
     SET declaration_no = v.declaration_no, declaration_date = v.declaration_date, declaration_type = v.declaration_type
   WHERE t.id = p_tx
     AND (t.declaration_no, t.declaration_date, t.declaration_type) IS DISTINCT FROM (v.declaration_no, v.declaration_date, v.declaration_type);
  PERFORM set_config('marsa.g3_mirror', v_prev, true);
END $$;

CREATE OR REPLACE FUNCTION app.tg_declarations_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.sync_tx_declaration(NEW.transaction_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_mirror ON public.customs_declarations;
CREATE TRIGGER trg_mirror AFTER INSERT OR UPDATE ON public.customs_declarations
  FOR EACH ROW EXECUTE FUNCTION app.tg_declarations_mirror();

-- add_declaration(p_tx, {declaration_no, declaration_type?, declaration_date?, status? (default submitted),
--                        source?, source_document_id?, notes?, replaces_id?}, p_idem_key)
-- replaces_id = an explicit replacement of a declaration of this transaction that was cancelled earlier.
CREATE OR REPLACE FUNCTION public.add_declaration(p_tx uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions; v_replay jsonb; v_d public.customs_declarations; v_old public.customs_declarations;
  v_rep uuid; v_p jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.g3_lock_tx(p_tx, app.ops_writer_roles());
  v_replay := app.idem_begin('add_declaration', p_idem_key, jsonb_build_object('transaction_id', p_tx, 'payload', p_payload), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_p := p_payload - 'idempotencyKey';
  v_rep := app.puuid(v_p, 'replaces_id');
  IF v_rep IS NOT NULL THEN
    SELECT * INTO v_old FROM public.customs_declarations d WHERE d.id = v_rep AND d.transaction_id = v_tx.id FOR UPDATE;
    IF v_old.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'replaces_id'); END IF;
    IF v_old.status <> 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'replaces_id'); END IF;
  END IF;
  v_d := app.decl_insert(v_tx, v_p - 'replaces_id', v_rep IS NOT NULL);
  IF v_rep IS NOT NULL THEN
    UPDATE public.customs_declarations d SET status = 'replaced', replaced_by_id = v_d.id WHERE d.id = v_old.id
    RETURNING * INTO v_old;
    PERFORM app.decl_event(v_old, 'replaced', 'cancelled', NULL, jsonb_build_object('replaced_by_id', v_d.id));
  END IF;
  RETURN app.idem_finish('add_declaration', p_idem_key, app.decl_json(v_d) || jsonb_build_object('replaced_id', v_rep));
END $$;

-- set_declaration_status(p_id, draft|submitted|under_inspection|released, p_note)
-- Forward = any ops writer. Backward = correction: note + senior role. Cancel / replace → cancel_declaration.
CREATE OR REPLACE FUNCTION public.set_declaration_status(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.customs_declarations; v_tx public.transactions; v_from text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_order text[] := ARRAY['draft','submitted','under_inspection','released'];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_d FROM public.customs_declarations d WHERE d.id = p_id;
  IF v_d.id IS NULL OR NOT app.has_tx_role(v_d.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_d.transaction_id, app.ops_writer_roles());
  SELECT * INTO v_d FROM public.customs_declarations d WHERE d.id = p_id FOR UPDATE;
  IF p_status IN ('cancelled','replaced') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'use_cancel_declaration'); END IF;
  IF p_status IS NULL OR NOT (p_status = ANY (v_order)) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_d.status IN ('cancelled','replaced') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  IF v_d.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF array_position(v_order, p_status) < array_position(v_order, v_d.status) THEN
    IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED'); END IF;
    IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, ARRAY['operations_manager','branch_manager','supervisor','admin']) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'role');
    END IF;
  END IF;
  v_from := v_d.status;
  UPDATE public.customs_declarations d SET status = p_status WHERE d.id = v_d.id RETURNING * INTO v_d;
  PERFORM app.decl_event(v_d, 'status', v_from, v_note);
  RETURN app.decl_json(v_d) || jsonb_build_object('from', v_from);
END $$;

-- cancel_declaration(p_id, p_reason, p_replacement) — cancel, and optionally add the replacement
-- (same payload as add_declaration, the number may be the same) linked via replaced_by_id, atomically.
-- Migration B owns the final version (+ declaration_cancelled exception): created here only while B
-- is not applied, so re-running this file alone never downgrades it.
DO $g3a_cancel$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_versions v WHERE v.version = '20261103000200') THEN
    RAISE NOTICE 'g3_registry: cancel_declaration kept (migration 20261103000200 owns it)';
    RETURN;
  END IF;
  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.cancel_declaration(p_id uuid, p_reason text, p_replacement jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.customs_declarations; v_new public.customs_declarations; v_tx public.transactions; v_from text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
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
  IF p_replacement IS NOT NULL AND jsonb_typeof(p_replacement) = 'object' THEN
    v_new := app.decl_insert(v_tx, p_replacement - 'idempotencyKey', true);
    UPDATE public.customs_declarations d SET status = 'replaced', replaced_by_id = v_new.id WHERE d.id = v_d.id
    RETURNING * INTO v_d;
    PERFORM app.decl_event(v_d, 'replaced', 'cancelled', NULL, jsonb_build_object('replaced_by_id', v_new.id));
  END IF;
  RETURN jsonb_build_object('cancelled', app.decl_json(v_d),
                            'replacement', CASE WHEN v_new.id IS NOT NULL THEN app.decl_json(v_new) END);
END $$
$fn$;
END $g3a_cancel$;

-- correct_declaration(p_id, {declaration_no?, declaration_type?, declaration_date?, notes?, source_document_id?}, p_reason)
-- audit_log keeps before/after (generic trigger); the event carries the changed fields and the reason.
CREATE OR REPLACE FUNCTION public.correct_declaration(p_id uuid, p_payload jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.customs_declarations; v_new public.customs_declarations; v_tx public.transactions; v_f jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before jsonb; v_after jsonb; v_doc uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_d FROM public.customs_declarations d WHERE d.id = p_id;
  IF v_d.id IS NULL OR NOT app.has_tx_role(v_d.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_tx := app.g3_lock_tx(v_d.transaction_id, app.ops_writer_roles());
  SELECT * INTO v_d FROM public.customs_declarations d WHERE d.id = p_id FOR UPDATE;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  IF v_d.status IN ('cancelled','replaced') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['declaration_no','declaration_type','declaration_date','notes','source_document_id']);
  v_f := app.decl_fields(p_payload);
  IF v_f = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  IF v_f ? 'declaration_no' AND v_f ->> 'declaration_no' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_no'); END IF;
  v_doc := (v_f ->> 'source_document_id')::uuid;
  IF v_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.documents d
       WHERE d.id = v_doc AND d.transaction_id = v_d.transaction_id AND d.voided_at IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', 'source_document_id');
  END IF;
  IF v_f ? 'declaration_no' AND v_f ->> 'declaration_no' <> v_d.declaration_no THEN
    PERFORM app.decl_no_check(v_d.org_id, v_d.transaction_id, v_f ->> 'declaration_no', v_d.id, false);
  END IF;
  UPDATE public.customs_declarations d SET
    declaration_no     = CASE WHEN v_f ? 'declaration_no' THEN v_f ->> 'declaration_no' ELSE d.declaration_no END,
    declaration_type   = CASE WHEN v_f ? 'declaration_type' THEN v_f ->> 'declaration_type' ELSE d.declaration_type END,
    declaration_date   = CASE WHEN v_f ? 'declaration_date' THEN (v_f ->> 'declaration_date')::date ELSE d.declaration_date END,
    notes              = CASE WHEN v_f ? 'notes' THEN v_f ->> 'notes' ELSE d.notes END,
    source_document_id = CASE WHEN v_f ? 'source_document_id' THEN v_doc ELSE d.source_document_id END,
    corrected_at       = now()
   WHERE d.id = v_d.id RETURNING * INTO v_new;
  SELECT jsonb_object_agg(k, to_jsonb(v_d) -> k), jsonb_object_agg(k, to_jsonb(v_new) -> k) INTO v_before, v_after
    FROM jsonb_object_keys(v_f) k WHERE (to_jsonb(v_d) -> k) IS DISTINCT FROM (to_jsonb(v_new) -> k);
  IF v_before IS NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'no_change'); END IF;
  PERFORM app.decl_event(v_new, 'corrected', v_new.status, v_reason, jsonb_build_object('before', v_before, 'after', v_after));
  RETURN app.decl_json(v_new) || jsonb_build_object('changed', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(v_after) k));
END $$;

-- ---------------------------------------------------------------------
-- 5. bills of lading + transaction links (G3.6)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bills_of_lading (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  bl_number         text NOT NULL CHECK (char_length(bl_number) BETWEEN 1 AND 40
                      AND bl_number = upper(bl_number) AND bl_number !~ '[[:space:]]'),
  bl_type           text NOT NULL DEFAULT 'master' CHECK (bl_type IN ('master','house','sea_waybill','awb','other')),
  shipping_agent_id uuid,
  carrier_name      text CHECK (char_length(carrier_name) <= 120),
  vessel            text CHECK (char_length(vessel) <= 80),
  voyage            text CHECK (char_length(voyage) <= 40),
  port_of_loading   text CHECK (char_length(port_of_loading) <= 80),
  port_of_discharge text CHECK (char_length(port_of_discharge) <= 80),
  origin_country    text CHECK (char_length(origin_country) <= 80),
  goods_description text CHECK (char_length(goods_description) <= 1000),
  packages          int CHECK (packages >= 0),
  gross_weight_kg   numeric(14,3) CHECK (gross_weight_kg >= 0),
  issued_at         date,
  notes             text CHECK (char_length(notes) <= 2000),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bills_of_lading_agent_fk FOREIGN KEY (shipping_agent_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT bills_of_lading_number_uniq UNIQUE (org_id, bl_number, bl_type),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.bills_of_lading IS 'G3.6 bills of lading / air waybills (org master data). Linked many-to-many to transactions via transaction_bls.';

CREATE TABLE IF NOT EXISTS public.transaction_bls (
  transaction_id uuid NOT NULL,
  bl_id          uuid NOT NULL,
  org_id         uuid NOT NULL,
  is_primary     boolean NOT NULL DEFAULT false,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transaction_id, bl_id),
  CONSTRAINT transaction_bls_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT transaction_bls_bl_fk FOREIGN KEY (bl_id, org_id) REFERENCES public.bills_of_lading(id, org_id)
);
COMMENT ON TABLE public.transaction_bls IS 'G3.6 transaction ↔ B/L links (no 1:1 forced). transactions.bl_number mirrors the primary link.';
CREATE UNIQUE INDEX IF NOT EXISTS transaction_bls_primary_uidx ON public.transaction_bls (transaction_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS transaction_bls_bl_idx ON public.transaction_bls (bl_id);

-- mirror: transactions.bl_number = number of the primary B/L (or NULL)
CREATE OR REPLACE FUNCTION app.sync_tx_bl(p_tx uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_no text; v_prev text := coalesce(current_setting('marsa.g3_mirror', true), '');
BEGIN
  SELECT b.bl_number INTO v_no FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
   WHERE tb.transaction_id = p_tx AND tb.is_primary;
  PERFORM set_config('marsa.g3_mirror', 'on', true);
  UPDATE public.transactions t SET bl_number = v_no WHERE t.id = p_tx AND t.bl_number IS DISTINCT FROM v_no;
  PERFORM set_config('marsa.g3_mirror', v_prev, true);
END $$;

-- link rows: re-sync the transaction (skipped while app.bl_link swaps the primary in two steps)
CREATE OR REPLACE FUNCTION app.tg_transaction_bls_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(current_setting('marsa.g3_bl_batch', true), '') = 'on' THEN RETURN NULL; END IF;
  PERFORM app.sync_tx_bl(coalesce(NEW.transaction_id, OLD.transaction_id));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_mirror ON public.transaction_bls;
CREATE TRIGGER trg_mirror AFTER INSERT OR UPDATE OR DELETE ON public.transaction_bls
  FOR EACH ROW EXECUTE FUNCTION app.tg_transaction_bls_mirror();

-- a renumbered B/L re-mirrors every transaction where it is primary
CREATE OR REPLACE FUNCTION app.tg_bills_of_lading_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  IF NEW.bl_number IS DISTINCT FROM OLD.bl_number THEN
    FOR r IN SELECT tb.transaction_id FROM public.transaction_bls tb WHERE tb.bl_id = NEW.id AND tb.is_primary LOOP
      PERFORM app.sync_tx_bl(r.transaction_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_mirror ON public.bills_of_lading;
CREATE TRIGGER trg_mirror AFTER UPDATE ON public.bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION app.tg_bills_of_lading_mirror();

CREATE OR REPLACE FUNCTION app.bl_event(p_tx public.transactions, p_bl public.bills_of_lading, p_op text, p_note text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
  VALUES (p_tx.org_id, p_tx.id, 'bl', left(p_note, 2000), false, auth.uid(),
          jsonb_build_object('op', p_op, 'bl_id', p_bl.id, 'bl_number', p_bl.bl_number, 'bl_type', p_bl.bl_type)
          || coalesce(p_extra, '{}'::jsonb));
END $$;

-- link (or re-flag) a B/L on a transaction. The first link of a transaction becomes primary.
CREATE OR REPLACE FUNCTION app.bl_link(p_tx public.transactions, p_bl uuid, p_primary boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_b public.bills_of_lading; v_link public.transaction_bls; v_primary boolean; v_shared boolean;
  v_prev text := coalesce(current_setting('marsa.g3_bl_batch', true), '');
BEGIN
  SELECT * INTO v_b FROM public.bills_of_lading b WHERE b.id = p_bl AND b.org_id = p_tx.org_id;
  IF v_b.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'bl'); END IF;
  SELECT * INTO v_link FROM public.transaction_bls tb WHERE tb.transaction_id = p_tx.id AND tb.bl_id = p_bl;
  -- a deliberate staff link may share a B/L with another client's transaction (consolidated master B/L):
  -- allowed, flagged in the result and the event (the UI warns); clients of a shared B/L no longer read it
  v_shared := EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.transactions x ON x.id = tb.transaction_id
                       WHERE tb.bl_id = p_bl AND x.id <> p_tx.id AND x.client_id IS DISTINCT FROM p_tx.client_id);
  v_primary := coalesce(p_primary, false)
               OR NOT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.transaction_id = p_tx.id AND tb.is_primary);
  IF v_link.bl_id IS NOT NULL AND (v_link.is_primary OR NOT v_primary) THEN
    RETURN jsonb_build_object('transaction_id', p_tx.id, 'bl_id', p_bl, 'is_primary', v_link.is_primary, 'already_linked', true,
                              'shared_with_other_client', v_shared);
  END IF;
  PERFORM set_config('marsa.g3_bl_batch', 'on', true);
  IF v_primary THEN
    UPDATE public.transaction_bls tb SET is_primary = false WHERE tb.transaction_id = p_tx.id AND tb.is_primary;
  END IF;
  IF v_link.bl_id IS NOT NULL THEN
    UPDATE public.transaction_bls tb SET is_primary = true WHERE tb.transaction_id = p_tx.id AND tb.bl_id = p_bl;
  ELSE
    INSERT INTO public.transaction_bls (transaction_id, bl_id, org_id, is_primary, created_by)
    VALUES (p_tx.id, p_bl, p_tx.org_id, v_primary, auth.uid());
  END IF;
  PERFORM set_config('marsa.g3_bl_batch', v_prev, true);
  PERFORM app.sync_tx_bl(p_tx.id);
  PERFORM app.bl_event(p_tx, v_b, CASE WHEN v_link.bl_id IS NOT NULL THEN 'primary' ELSE 'linked' END, NULL,
                       jsonb_build_object('is_primary', v_primary)
                       || CASE WHEN v_shared THEN jsonb_build_object('shared_with_other_client', true) ELSE '{}'::jsonb END);
  RETURN jsonb_build_object('transaction_id', p_tx.id, 'bl_id', p_bl, 'is_primary', v_primary, 'already_linked', v_link.bl_id IS NOT NULL,
                            'shared_with_other_client', v_shared);
END $$;

-- payload → normalized B/L fields (only keys present in p)
CREATE OR REPLACE FUNCTION app.bl_fields(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; s text; n numeric; k text;
BEGIN
  IF p ? 'bl_number' THEN
    s := app.norm_code(app.ptext(p, 'bl_number', 80, true));
    IF char_length(s) > 40 THEN PERFORM app.fail('MRS_TOO_LONG', 'bl_number'); END IF;
    v := v || jsonb_build_object('bl_number', s);
  END IF;
  IF p ? 'bl_type' THEN
    s := app.ptext(p, 'bl_type', 20);
    IF s IS NULL OR s NOT IN ('master','house','sea_waybill','awb','other') THEN PERFORM app.fail('MRS_INVALID', 'bl_type'); END IF;
    v := v || jsonb_build_object('bl_type', s);
  END IF;
  IF p ? 'shipping_agent_id' THEN v := v || jsonb_build_object('shipping_agent_id', app.puuid(p, 'shipping_agent_id')); END IF;
  FOREACH k IN ARRAY ARRAY['carrier_name:120','vessel:80','voyage:40','port_of_loading:80','port_of_discharge:80',
                           'origin_country:80','goods_description:1000','notes:2000'] LOOP
    IF p ? split_part(k, ':', 1) THEN
      v := v || jsonb_build_object(split_part(k, ':', 1), app.ptext(p, split_part(k, ':', 1), split_part(k, ':', 2)::int));
    END IF;
  END LOOP;
  IF p ? 'packages' THEN
    n := app.pnum(p, 'packages', 10000000);
    IF n IS NOT NULL AND n <> trunc(n) THEN PERFORM app.fail('MRS_INVALID', 'packages'); END IF;
    v := v || jsonb_build_object('packages', n::int);
  END IF;
  IF p ? 'gross_weight_kg' THEN v := v || jsonb_build_object('gross_weight_kg', app.pnum(p, 'gross_weight_kg', 99999999999)); END IF;
  IF p ? 'issued_at' THEN v := v || jsonb_build_object('issued_at', app.pdate(p, 'issued_at')); END IF;
  RETURN v;
END $$;

-- save_bl({id? | org_id? | transaction_id?, bl_number, bl_type, shipping_agent_id, carrier_name, vessel, voyage,
--          port_of_loading, port_of_discharge, origin_country, goods_description, packages, gross_weight_kg,
--          issued_at, notes, primary?}, p_idem_key)
--   no id: create; an existing (org, bl_number, bl_type) is returned unchanged (existing:true), never duplicated
--          (MRS_FORBIDDEN 'bl_other_branch' when that B/L only feeds transactions the caller cannot read)
--   id:    partial update (keys present only); needs ops-writer rights on every linked transaction
--   transaction_id: also links the B/L to that transaction (primary when asked, or when it has none yet)
CREATE OR REPLACE FUNCTION public.save_bl(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid; v_tx_id uuid; v_org uuid; v_tx public.transactions; v_b public.bills_of_lading; v_old public.bills_of_lading;
  v_f jsonb; v_replay jsonb; v_created boolean := false; v_existing boolean := false; v_link jsonb; v_agent uuid;
  v_t public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['id','org_id','transaction_id','primary','idempotencyKey','bl_number','bl_type',
    'shipping_agent_id','carrier_name','vessel','voyage','port_of_loading','port_of_discharge','origin_country',
    'goods_description','packages','gross_weight_kg','issued_at','notes']);
  v_id := app.puuid(p_payload, 'id');
  v_tx_id := app.puuid(p_payload, 'transaction_id');
  v_org := app.puuid(p_payload, 'org_id');
  IF v_tx_id IS NOT NULL THEN
    v_tx := app.g3_lock_tx(v_tx_id, app.ops_writer_roles());
    IF v_org IS NOT NULL AND v_org <> v_tx.org_id THEN PERFORM app.fail('MRS_INVALID', 'org_id'); END IF;
    v_org := v_tx.org_id;
  END IF;
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.bills_of_lading b WHERE b.id = v_id FOR UPDATE;
    IF v_old.id IS NULL OR NOT app.can_read_bl(v_old.id, v_old.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'bl'); END IF;
    IF v_org IS NOT NULL AND v_org <> v_old.org_id THEN PERFORM app.fail('MRS_INVALID', 'org_id'); END IF;
    v_org := v_old.org_id;
  END IF;
  IF v_org IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'org_id'); END IF;
  IF NOT app.has_role(v_org, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('save_bl', p_idem_key, p_payload - 'idempotencyKey', v_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_f := app.bl_fields(p_payload);
  v_agent := (v_f ->> 'shipping_agent_id')::uuid;
  IF v_agent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parties pa
       WHERE pa.id = v_agent AND pa.org_id = v_org AND 'shipping_agent' = ANY (pa.kinds)) THEN
    PERFORM app.fail('MRS_INVALID', 'shipping_agent_id');
  END IF;

  IF v_id IS NULL THEN
    IF v_f ->> 'bl_number' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bl_number'); END IF;
    v_f := jsonb_build_object('bl_type', CASE WHEN v_tx.mode = 'air' THEN 'awb' ELSE 'master' END) || v_f;
    SELECT * INTO v_b FROM public.bills_of_lading b
     WHERE b.org_id = v_org AND b.bl_number = v_f ->> 'bl_number' AND b.bl_type = v_f ->> 'bl_type';
    IF v_b.id IS NOT NULL THEN
      -- the number is taken by a B/L of a branch the caller cannot read: say so, never hand out (or link) it
      IF NOT app.can_read_bl(v_b.id, v_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'bl_other_branch'); END IF;
      v_existing := true;
    ELSE
      INSERT INTO public.bills_of_lading (org_id, bl_number, bl_type, shipping_agent_id, carrier_name, vessel, voyage,
        port_of_loading, port_of_discharge, origin_country, goods_description, packages, gross_weight_kg, issued_at, notes, created_by)
      VALUES (v_org, v_f ->> 'bl_number', v_f ->> 'bl_type', v_agent, v_f ->> 'carrier_name', v_f ->> 'vessel', v_f ->> 'voyage',
        v_f ->> 'port_of_loading', v_f ->> 'port_of_discharge', v_f ->> 'origin_country', v_f ->> 'goods_description',
        (v_f ->> 'packages')::int, (v_f ->> 'gross_weight_kg')::numeric, (v_f ->> 'issued_at')::date, v_f ->> 'notes', auth.uid())
      RETURNING * INTO v_b;
      v_created := true;
    END IF;
  ELSE
    IF v_f ? 'bl_number' AND v_f ->> 'bl_number' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bl_number'); END IF;
    -- a shared B/L may only be edited by someone who may edit every transaction it feeds
    IF EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.transactions t ON t.id = tb.transaction_id
                WHERE tb.bl_id = v_old.id AND NOT app.has_branch_role(t.org_id, t.branch_id, app.ops_writer_roles())) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'branch');
    END IF;
    IF (v_f ? 'bl_number' OR v_f ? 'bl_type') AND EXISTS (SELECT 1 FROM public.bills_of_lading b
         WHERE b.org_id = v_org AND b.id <> v_old.id
           AND b.bl_number = coalesce(v_f ->> 'bl_number', v_old.bl_number) AND b.bl_type = coalesce(v_f ->> 'bl_type', v_old.bl_type)) THEN
      PERFORM app.fail('MRS_INVALID', 'bl_number_taken');
    END IF;
    UPDATE public.bills_of_lading b SET
      bl_number         = CASE WHEN v_f ? 'bl_number' THEN v_f ->> 'bl_number' ELSE b.bl_number END,
      bl_type           = CASE WHEN v_f ? 'bl_type' THEN v_f ->> 'bl_type' ELSE b.bl_type END,
      shipping_agent_id = CASE WHEN v_f ? 'shipping_agent_id' THEN v_agent ELSE b.shipping_agent_id END,
      carrier_name      = CASE WHEN v_f ? 'carrier_name' THEN v_f ->> 'carrier_name' ELSE b.carrier_name END,
      vessel            = CASE WHEN v_f ? 'vessel' THEN v_f ->> 'vessel' ELSE b.vessel END,
      voyage            = CASE WHEN v_f ? 'voyage' THEN v_f ->> 'voyage' ELSE b.voyage END,
      port_of_loading   = CASE WHEN v_f ? 'port_of_loading' THEN v_f ->> 'port_of_loading' ELSE b.port_of_loading END,
      port_of_discharge = CASE WHEN v_f ? 'port_of_discharge' THEN v_f ->> 'port_of_discharge' ELSE b.port_of_discharge END,
      origin_country    = CASE WHEN v_f ? 'origin_country' THEN v_f ->> 'origin_country' ELSE b.origin_country END,
      goods_description = CASE WHEN v_f ? 'goods_description' THEN v_f ->> 'goods_description' ELSE b.goods_description END,
      packages          = CASE WHEN v_f ? 'packages' THEN (v_f ->> 'packages')::int ELSE b.packages END,
      gross_weight_kg   = CASE WHEN v_f ? 'gross_weight_kg' THEN (v_f ->> 'gross_weight_kg')::numeric ELSE b.gross_weight_kg END,
      issued_at         = CASE WHEN v_f ? 'issued_at' THEN (v_f ->> 'issued_at')::date ELSE b.issued_at END,
      notes             = CASE WHEN v_f ? 'notes' THEN v_f ->> 'notes' ELSE b.notes END
     WHERE b.id = v_old.id RETURNING * INTO v_b;
    IF to_jsonb(v_b) - 'updated_at' IS DISTINCT FROM to_jsonb(v_old) - 'updated_at' THEN
      FOR v_t IN SELECT t.* FROM public.transaction_bls tb JOIN public.transactions t ON t.id = tb.transaction_id
                  WHERE tb.bl_id = v_b.id LOOP
        PERFORM app.bl_event(v_t, v_b, 'updated', NULL,
          jsonb_build_object('changed', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(to_jsonb(v_b)) k
                                          WHERE k <> 'updated_at' AND (to_jsonb(v_b) -> k) IS DISTINCT FROM (to_jsonb(v_old) -> k))));
      END LOOP;
    END IF;
  END IF;

  IF v_tx.id IS NOT NULL THEN
    v_link := app.bl_link(v_tx, v_b.id, app.pbool(p_payload, 'primary'));
  END IF;
  RETURN app.idem_finish('save_bl', p_idem_key, jsonb_build_object(
    'id', v_b.id, 'org_id', v_b.org_id, 'bl_number', v_b.bl_number, 'bl_type', v_b.bl_type,
    'created', v_created, 'existing', v_existing, 'linked', v_link IS NOT NULL,
    'is_primary', coalesce((v_link ->> 'is_primary')::boolean, false),
    'shared_with_other_client', coalesce((v_link ->> 'shared_with_other_client')::boolean, false)));
END $$;

CREATE OR REPLACE FUNCTION public.link_bl(p_tx uuid, p_bl uuid, p_primary boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.g3_lock_tx(p_tx, app.ops_writer_roles());
  IF p_bl IS NULL OR NOT app.can_read_bl(p_bl, v_tx.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'bl'); END IF;
  RETURN app.bl_link(v_tx, p_bl, p_primary);
END $$;

-- unlink_bl(p_tx, p_bl, p_reason): the B/L record stays; containers of this transaction that pointed
-- at it lose bl_id (FK ON DELETE SET NULL). An unlinked primary hands over to the oldest remaining link.
CREATE OR REPLACE FUNCTION public.unlink_bl(p_tx uuid, p_bl uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions; v_link public.transaction_bls; v_b public.bills_of_lading; v_n int; v_next uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.g3_lock_tx(p_tx, app.ops_writer_roles());
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  SELECT * INTO v_link FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id AND tb.bl_id = p_bl FOR UPDATE;
  IF v_link.bl_id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'link'); END IF;
  SELECT * INTO v_b FROM public.bills_of_lading b WHERE b.id = p_bl;
  SELECT count(*) INTO v_n FROM public.containers c WHERE c.transaction_id = v_tx.id AND c.bl_id = p_bl;
  DELETE FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id AND tb.bl_id = p_bl;
  IF v_link.is_primary THEN
    SELECT tb.bl_id INTO v_next FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id
     ORDER BY tb.created_at, tb.bl_id LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.transaction_bls tb SET is_primary = true WHERE tb.transaction_id = v_tx.id AND tb.bl_id = v_next;
    END IF;
  END IF;
  PERFORM app.bl_event(v_tx, v_b, 'unlinked', v_reason,
    jsonb_build_object('was_primary', v_link.is_primary, 'containers_cleared', v_n, 'promoted_bl_id', v_next));
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'bl_id', p_bl, 'was_primary', v_link.is_primary,
                            'containers_cleared', v_n, 'promoted_bl_id', v_next);
END $$;

-- ---------------------------------------------------------------------
-- 6. containers additions (G3.7)
-- ---------------------------------------------------------------------
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS bl_id uuid;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS seal_no text;
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS size_type text;            -- ISO size-type (e.g. 45G1); container_type stays
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS gross_weight_kg numeric(14,3);
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS operational_state text NOT NULL DEFAULT 'expected';
ALTER TABLE public.containers ADD COLUMN IF NOT EXISTS visit_ref text;            -- <container_no>@<transaction ref> (trigger)
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_seal_chk;
ALTER TABLE public.containers ADD CONSTRAINT containers_seal_chk CHECK (char_length(seal_no) <= 30);
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_size_type_chk;
ALTER TABLE public.containers ADD CONSTRAINT containers_size_type_chk CHECK (char_length(size_type) <= 10);
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_weight_chk;
ALTER TABLE public.containers ADD CONSTRAINT containers_weight_chk CHECK (gross_weight_kg >= 0);
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_operational_state_chk;
ALTER TABLE public.containers ADD CONSTRAINT containers_operational_state_chk CHECK (operational_state IN
  ('expected','at_port','released','gated_out','delivered','empty_returned'));
-- bl_id must be one of THIS transaction's B/Ls; unlinking the B/L clears it
ALTER TABLE public.containers DROP CONSTRAINT IF EXISTS containers_bl_fk;
ALTER TABLE public.containers ADD CONSTRAINT containers_bl_fk FOREIGN KEY (transaction_id, bl_id)
  REFERENCES public.transaction_bls (transaction_id, bl_id) ON DELETE SET NULL (bl_id);
CREATE INDEX IF NOT EXISTS containers_bl_idx ON public.containers (transaction_id, bl_id) WHERE bl_id IS NOT NULL;

-- visit_ref, normalization, receipt-verified → empty_returned; empty_returned needs a verified receipt
-- or a waiver (and is taken back when the verification is undone).
-- Fires after trg_before (tg_containers_before normalizes container_no / stamps verification).
CREATE OR REPLACE FUNCTION app.tg_containers_g3_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ref text;
BEGIN
  SELECT t.ref INTO v_ref FROM public.transactions t WHERE t.id = NEW.transaction_id;
  NEW.visit_ref := NEW.container_no || '@' || v_ref;
  NEW.seal_no := app.norm_code(NEW.seal_no);
  NEW.size_type := app.norm_code(NEW.size_type);
  IF NEW.return_status = 'returned_verified' AND (TG_OP = 'INSERT' OR OLD.return_status IS DISTINCT FROM 'returned_verified') THEN
    NEW.operational_state := 'empty_returned';
  ELSIF NEW.operational_state = 'empty_returned' AND NEW.return_status NOT IN ('returned_verified','waived') THEN
    IF TG_OP = 'UPDATE' AND OLD.operational_state = 'empty_returned' THEN
      -- verification undone (disputed / pending again): "returned" no longer holds → back to the last movement on file
      NEW.operational_state := CASE WHEN NEW.delivered_at IS NOT NULL THEN 'delivered'
                                    WHEN NEW.gate_out_at IS NOT NULL THEN 'gated_out' ELSE 'released' END;
    ELSE
      -- "returned" is never a claim: only a verified receipt (or a documented waiver) shows it to the client.
      -- A Return Note / a receipt awaiting verification (evidence_submitted) is not enough.
      PERFORM app.fail('MRS_EVIDENCE_INVALID', 'operational_state');
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_g3_before ON public.containers;
CREATE TRIGGER trg_g3_before BEFORE INSERT OR UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION app.tg_containers_g3_before();

CREATE OR REPLACE FUNCTION app.tg_containers_g3_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.operational_state IS DISTINCT FROM OLD.operational_state THEN
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
    VALUES (NEW.org_id, NEW.transaction_id, 'container', OLD.operational_state, NEW.operational_state, false, auth.uid(),
            jsonb_build_object('container_id', NEW.id, 'container_no', NEW.container_no, 'visit_ref', NEW.visit_ref));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g3_event ON public.containers;
CREATE TRIGGER trg_g3_event AFTER UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION app.tg_containers_g3_event();

-- app.tg_containers_before — body = 20261102000200, except: the evidence document is re-validated only
-- when it is attached or changed (INSERT / evidence_document_id changed). A receipt voided AFTER it was
-- attached no longer blocks every later write of the container (and the backfill UPDATE below).
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
    IF (TG_OP = 'INSERT' OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id)
       AND (v_doc.id IS NULL OR v_doc.transaction_id IS DISTINCT FROM NEW.transaction_id OR v_doc.voided_at IS NOT NULL) THEN
      PERFORM app.fail('MRS_EVIDENCE_INVALID', 'evidence_document_id');
    END IF;
  END IF;

  IF NEW.return_status = 'returned_verified'
     AND (TG_OP = 'INSERT' OR OLD.return_status IS DISTINCT FROM 'returned_verified'
          OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    -- only a staff-confirmed EMPTY RETURN RECEIPT proves return. EIR / return note / carrier message never do.
    IF v_doc.id IS NULL OR v_doc.classification IS DISTINCT FROM 'empty_return_receipt'
       OR v_doc.classification_status NOT IN ('confirmed','reclassified') OR v_doc.voided_at IS NOT NULL THEN
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

-- backfill: visit_ref for every row, operational_state from what is already known
UPDATE public.containers c SET operational_state = CASE
    WHEN c.return_status = 'returned_verified' THEN 'empty_returned'
    WHEN c.delivered_at IS NOT NULL THEN 'delivered'
    WHEN c.gate_out_at IS NOT NULL THEN 'gated_out'
    ELSE c.operational_state END
 WHERE c.visit_ref IS NULL;
ALTER TABLE public.containers ALTER COLUMN visit_ref SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS containers_visit_ref_uidx ON public.containers (org_id, visit_ref);

-- container_history(p_org, p_container_no) — every visit of a number the caller may read (branch-scoped)
CREATE OR REPLACE FUNCTION public.container_history(p_org uuid, p_container_no text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_no text := upper(regexp_replace(app.to_western(coalesce(p_container_no, '')), '[[:space:]-]', '', 'g'));
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF v_no !~ '^[A-Z]{4}[0-9]{7}$' THEN PERFORM app.fail('MRS_INVALID', 'container_no'); END IF;
  RETURN jsonb_build_object('container_no', v_no, 'visits', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'container_id', c.id, 'visit_ref', c.visit_ref, 'transaction_id', t.id, 'ref', t.ref, 'branch_id', t.branch_id,
             'client_id', t.client_id, 'client_name_ar', cl.name_ar, 'operational_status', t.operational_status,
             'operational_state', c.operational_state, 'return_status', c.return_status, 'return_deadline', c.return_deadline,
             'returned_at', c.returned_at, 'gate_out_at', c.gate_out_at, 'delivered_at', c.delivered_at,
             'container_type', c.container_type, 'size_type', c.size_type, 'seal_no', c.seal_no,
             'bl_id', c.bl_id, 'bl_number', b.bl_number, 'created_at', c.created_at)
             ORDER BY c.created_at DESC, c.id)
      FROM public.containers c
      JOIN public.transactions t ON t.id = c.transaction_id
      JOIN public.clients cl ON cl.id = t.client_id
      LEFT JOIN public.bills_of_lading b ON b.id = c.bl_id
     WHERE c.org_id = p_org AND c.container_no = v_no
       AND app.has_branch_role(t.org_id, t.branch_id, app.staff_roles())), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------
-- 7. legacy adoption: direct writes of transactions.declaration_* / bl_number
--    (and the backfill below) land in the new tables. The mirror's own writes
--    are skipped (app.g3_mirroring()).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.adopt_tx_declaration(t public.transactions, p_via text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_no text := app.norm_code(t.declaration_no); v_d public.customs_declarations; v_at timestamptz;
BEGIN
  SELECT * INTO v_d FROM public.customs_declarations d
   WHERE d.transaction_id = t.id AND d.status NOT IN ('cancelled','replaced')
   ORDER BY d.created_at DESC, d.id DESC LIMIT 1 FOR UPDATE;
  IF v_no IS NULL THEN
    -- clearing the number on the transaction record is not a cancellation (reason + exception):
    -- that goes through cancel_declaration
    IF v_d.id IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'use_cancel_declaration'); END IF;
  ELSIF v_d.id IS NULL THEN
    -- a cancelled / replaced number comes back only as an explicit replacement
    -- (cancel_declaration p_replacement, add_declaration replaces_id), never from the record
    PERFORM app.decl_no_check(t.org_id, t.id, v_no, NULL, false);
    -- backfill: keep the legacy timeline (and the "stalled" age) instead of stamping the migration time
    IF p_via = 'backfill' THEN
      v_at := least(clock_timestamp(), coalesce(t.declaration_date::timestamptz, t.status_changed_at, t.created_at));
    END IF;
    INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, declaration_type, declaration_date,
                                             status, source, created_by, created_at, updated_at)
    VALUES (t.org_id, t.id, v_no, t.declaration_type, t.declaration_date, 'submitted', 'manual', coalesce(auth.uid(), t.created_by),
            coalesce(v_at, clock_timestamp()), coalesce(v_at, now()))
    RETURNING * INTO v_d;
    PERFORM app.decl_event(v_d, 'added', NULL, NULL, jsonb_build_object('via', p_via, 'source', v_d.source)
                           || CASE WHEN v_at IS NOT NULL THEN jsonb_build_object('backdated', true) ELSE '{}'::jsonb END);
  ELSIF v_no <> v_d.declaration_no THEN
    -- renumbering an active declaration is a correction with a reason (audit before/after)
    PERFORM app.fail('MRS_BAD_TRANSITION', 'use_correct_declaration');
  ELSIF (v_d.declaration_type, v_d.declaration_date) IS DISTINCT FROM (t.declaration_type, t.declaration_date) THEN
    UPDATE public.customs_declarations d SET declaration_type = t.declaration_type,
           declaration_date = t.declaration_date, corrected_at = now()
     WHERE d.id = v_d.id RETURNING * INTO v_d;
    PERFORM app.decl_event(v_d, 'corrected', v_d.status, NULL, jsonb_build_object('via', p_via, 'legacy_edit', true));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.adopt_tx_bl(t public.transactions, p_via text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_no text := app.norm_code(t.bl_number); v_cur record; v_b public.bills_of_lading; v_old public.bills_of_lading;
  v_type text := CASE WHEN t.mode = 'air' THEN 'awb' ELSE 'other' END;
  v_prev text := coalesce(current_setting('marsa.g3_bl_batch', true), '');
BEGIN
  SELECT tb.bl_id, b.bl_number INTO v_cur FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
   WHERE tb.transaction_id = t.id AND tb.is_primary;
  IF v_cur.bl_id IS NOT NULL AND v_cur.bl_number IS NOT DISTINCT FROM v_no THEN RETURN; END IF;
  IF v_cur.bl_id IS NOT NULL THEN SELECT * INTO v_old FROM public.bills_of_lading b WHERE b.id = v_cur.bl_id; END IF;
  IF v_no IS NULL THEN
    -- clearing the number DEMOTES the primary link: it stays linked (containers keep bl_id);
    -- removing a link is unlink_bl with a reason
    IF v_old.id IS NOT NULL THEN
      PERFORM set_config('marsa.g3_bl_batch', 'on', true);
      UPDATE public.transaction_bls tb SET is_primary = false WHERE tb.transaction_id = t.id AND tb.is_primary;
      PERFORM set_config('marsa.g3_bl_batch', v_prev, true);
      PERFORM app.bl_event(t, v_old, 'demoted', NULL, jsonb_build_object('via', p_via, 'was_primary', true));
    END IF;
    RETURN;
  END IF;
  -- same number already known in the org: reuse it only while every transaction it feeds belongs to the
  -- same client AND branch. A number typed on intake / the record never links another client's (or
  -- another branch's) B/L: staff decide that explicitly (save_bl / link_bl).
  SELECT * INTO v_b FROM public.bills_of_lading b
   WHERE b.org_id = t.org_id AND b.bl_number = v_no
     AND NOT EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.transactions x ON x.id = tb.transaction_id
                      WHERE tb.bl_id = b.id AND x.id <> t.id
                        AND (x.client_id IS DISTINCT FROM t.client_id OR x.branch_id IS DISTINCT FROM t.branch_id))
   ORDER BY (b.bl_type = v_type) DESC, b.created_at, b.id LIMIT 1;
  PERFORM set_config('marsa.g3_bl_batch', 'on', true);
  -- the previous primary stays linked as a secondary B/L (never deleted by a record edit)
  UPDATE public.transaction_bls tb SET is_primary = false WHERE tb.transaction_id = t.id AND tb.is_primary;
  IF v_b.id IS NULL AND EXISTS (SELECT 1 FROM public.bills_of_lading b WHERE b.org_id = t.org_id AND b.bl_number = v_no) THEN
    -- conflict: the number belongs to a B/L that feeds another client / branch. No link; the transaction
    -- keeps the plain number (no mirror sync) and an internal event asks staff to decide.
    PERFORM set_config('marsa.g3_bl_batch', v_prev, true);
    IF NOT EXISTS (SELECT 1 FROM public.transaction_events e
                    WHERE e.transaction_id = t.id AND e.event_type = 'bl' AND e.payload ->> 'op' = 'conflict'
                      AND e.payload ->> 'bl_number' = v_no) THEN
      INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, actor, payload)
      VALUES (t.org_id, t.id, 'bl', false, auth.uid(),
              jsonb_build_object('op', 'conflict', 'bl_number', v_no, 'reason', 'bl_feeds_other_client_or_branch', 'via', p_via,
                                 'demoted_bl_id', v_old.id));
    END IF;
    RETURN;
  END IF;
  IF v_b.id IS NULL THEN
    -- legacy value: the document type is unknown → 'other' (air → 'awb'); staff can correct it with save_bl
    INSERT INTO public.bills_of_lading (org_id, bl_number, bl_type, carrier_name, port_of_loading, port_of_discharge,
                                        origin_country, goods_description, created_by)
    VALUES (t.org_id, v_no, v_type, left(t.shipping_line, 120),
            t.port_of_loading, t.port_of_discharge, CASE WHEN t.operation = 'import' THEN t.country END,
            t.goods_description, coalesce(auth.uid(), t.created_by))
    RETURNING * INTO v_b;
  END IF;
  INSERT INTO public.transaction_bls (transaction_id, bl_id, org_id, is_primary, created_by)
  VALUES (t.id, v_b.id, t.org_id, true, coalesce(auth.uid(), t.created_by))
  ON CONFLICT (transaction_id, bl_id) DO UPDATE SET is_primary = true;
  PERFORM set_config('marsa.g3_bl_batch', v_prev, true);
  PERFORM app.sync_tx_bl(t.id);
  PERFORM app.bl_event(t, v_b, 'linked', NULL, jsonb_build_object('via', p_via, 'is_primary', true, 'demoted_bl_id', v_old.id));
END $$;

CREATE OR REPLACE FUNCTION app.tg_transactions_g3_adopt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF app.g3_mirroring() THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' OR (NEW.declaration_no, NEW.declaration_date, NEW.declaration_type)
                         IS DISTINCT FROM (OLD.declaration_no, OLD.declaration_date, OLD.declaration_type) THEN
    PERFORM app.adopt_tx_declaration(NEW, 'transaction_edit');
  END IF;
  IF TG_OP = 'INSERT' OR NEW.bl_number IS DISTINCT FROM OLD.bl_number THEN
    PERFORM app.adopt_tx_bl(NEW, 'transaction_edit');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g3_adopt ON public.transactions;
CREATE TRIGGER trg_g3_adopt AFTER INSERT OR UPDATE OF declaration_no, declaration_date, declaration_type, bl_number
  ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_g3_adopt();

-- backfill (idempotent: an already-adopted value is left alone)
DO $$
DECLARE t public.transactions;
BEGIN
  FOR t IN SELECT * FROM public.transactions x WHERE x.declaration_no IS NOT NULL OR x.bl_number IS NOT NULL ORDER BY x.created_at, x.id LOOP
    IF t.declaration_no IS NOT NULL THEN PERFORM app.adopt_tx_declaration(t, 'backfill'); END IF;
    IF t.bl_number IS NOT NULL THEN PERFORM app.adopt_tx_bl(t, 'backfill'); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 8. transaction_completeness(p_tx) (G3.4) — data + documents.
--    {score 0–100, missing:[{field|document, label_ar, label_en, required_for, status}], ready_for:[stage…],
--     ready_limit, advisory:true}. ready_for = the next stages whose data / documents are on file; stages after
--    customs_declaration need a RELEASED declaration (ready_limit = 'declaration_release'). It is a checklist,
--    never a clearance decision. Migration B recreates this function to add document_requirements.
-- ---------------------------------------------------------------------
-- Migration B owns the final version (+ document_requirements): created here only while B is not applied.
DO $g3a_completeness$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_versions v WHERE v.version = '20261103000200') THEN
    RAISE NOTICE 'g3_registry: transaction_completeness kept (migration 20261103000200 owns it)';
    RETURN;
  END IF;
  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.transaction_completeness(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions;
  v_items jsonb := '[]'::jsonb;
  v_docs text[]; v_kind text; v_st text;
  v_n_ct int; v_open int; v_cur int; v_ready jsonb := '[]'::jsonb; v_total int; v_ok int; s record;
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
      'ok', v_st = 'satisfied', 'status', v_st, 'label_ar', coalesce(l.label_ar, v_kind), 'label_en', coalesce(l.label_en, v_kind))
      FROM (SELECT 1) one LEFT JOIN public.status_labels l ON l.domain = 'document_kind' AND l.code = v_kind));
  END LOOP;

  SELECT count(*), count(*) FILTER (WHERE (i ->> 'ok')::boolean) INTO v_total, v_ok FROM jsonb_array_elements(v_items) i;

  -- consecutive next stages (up to operationally_complete) with nothing missing for them or earlier
  v_released := EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = v_tx.id AND d.status = 'released');
  v_cur := app.code_sort('operational_status', v_tx.operational_status);
  FOR s IN SELECT l.code, l.sort FROM public.status_labels l
            WHERE l.domain = 'operational_status' AND l.sort > v_cur
              AND l.sort <= app.code_sort('operational_status', 'operationally_complete') ORDER BY l.sort LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i
                       WHERE NOT (i ->> 'ok')::boolean AND app.code_sort('operational_status', i ->> 'required_for') <= s.sort);
    -- stages after customs_declaration follow customs release: never listed before a declaration is released
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
    'missing', coalesce((SELECT jsonb_agg(i - 'ok' ORDER BY app.code_sort('operational_status', i ->> 'required_for'), ord)
                           FROM jsonb_array_elements(v_items) WITH ORDINALITY AS x(i, ord) WHERE NOT (i ->> 'ok')::boolean), '[]'::jsonb),
    'ready_for', v_ready,
    'ready_limit', v_limit,
    'advisory', true);
END $$
$fn$;
END $g3a_completeness$;

-- ---------------------------------------------------------------------
-- 9. staff_internal_fields: + customs_declarations (notes, cancel_reason), bills_of_lading (notes)
--    (body otherwise identical to 0700)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_internal_fields(p_table text, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_ids) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  IF p_table = 'transactions' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(t.id::text, jsonb_build_object('notes', t.notes))
        FROM public.transactions t
       WHERE t.id = ANY (p_ids) AND app.has_branch_role(t.org_id, t.branch_id, app.staff_roles())), '{}'::jsonb);
  ELSIF p_table = 'clients' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(c.id::text, jsonb_build_object('notes', c.notes, 'classification', c.classification))
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
-- 10. generic triggers (updated_at, creator stamp, immutables, audit)
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parties','drivers','trucks','customs_declarations','bills_of_lading'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['parties','drivers','trucks','client_aliases'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_stamp ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_stamp BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_guard BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic(%L, %L, %L, %L)',
                   t, 'id', 'org_id', 'created_by', 'created_at');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['parties','drivers','trucks','client_aliases','customs_declarations','bills_of_lading','transaction_bls'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 11. RLS, policies, grants
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parties','drivers','trucks','client_aliases','customs_declarations','bills_of_lading','transaction_bls'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated', t);
  END LOOP;
END $$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['parties','drivers','trucks','client_aliases','customs_declarations',
  'bills_of_lading','transaction_bls']) t;

-- client visibility: B/L linked to one of the caller's (client) transactions and to NO transaction of
-- another client (a consolidated / shared B/L never shows one client another client's cargo details)
CREATE OR REPLACE FUNCTION app.is_bl_client(p_bl uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.bl_id = p_bl AND app.is_tx_client(tb.transaction_id))
     AND NOT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.bl_id = p_bl AND NOT app.is_tx_client(tb.transaction_id))
$$;

-- staff visibility: branch scoping through the transactions the B/L feeds. A B/L linked to nothing yet
-- (registered, link pending) is read by the org's ops writers.
CREATE OR REPLACE FUNCTION app.can_read_bl(p_bl uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.transaction_bls tb
                  WHERE tb.bl_id = p_bl AND app.has_tx_role(tb.transaction_id, app.staff_roles()))
      OR (NOT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.bl_id = p_bl)
          AND app.has_role(p_org, app.ops_writer_roles()))
$$;

-- directories: staff read, transport writers write directly; no DELETE (deactivate with is_active)
CREATE POLICY parties_select ON public.parties FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY parties_insert ON public.parties FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
CREATE POLICY parties_update ON public.parties FOR UPDATE TO authenticated
  USING (app.has_role(org_id, app.transport_writer_roles())) WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
CREATE POLICY drivers_select ON public.drivers FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY drivers_insert ON public.drivers FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
CREATE POLICY drivers_update ON public.drivers FOR UPDATE TO authenticated
  USING (app.has_role(org_id, app.transport_writer_roles())) WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
CREATE POLICY trucks_select ON public.trucks FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY trucks_insert ON public.trucks FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
CREATE POLICY trucks_update ON public.trucks FOR UPDATE TO authenticated
  USING (app.has_role(org_id, app.transport_writer_roles())) WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
REVOKE DELETE ON public.parties, public.drivers, public.trucks FROM authenticated;

-- aliases: staff read, ops writers add / remove (no UPDATE: remove + add)
CREATE POLICY client_aliases_select ON public.client_aliases FOR SELECT TO authenticated USING (app.is_staff(org_id));
CREATE POLICY client_aliases_insert ON public.client_aliases FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, app.ops_writer_roles()));
CREATE POLICY client_aliases_delete ON public.client_aliases FOR DELETE TO authenticated USING (app.has_role(org_id, app.ops_writer_roles()));
REVOKE UPDATE ON public.client_aliases FROM authenticated;

-- declarations / B/Ls / links: written through the RPCs only; clients read their own (no internal columns)
CREATE POLICY customs_declarations_select ON public.customs_declarations FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()) OR app.is_tx_client(transaction_id));
CREATE POLICY bills_of_lading_select ON public.bills_of_lading FOR SELECT TO authenticated
  USING (app.can_read_bl(id, org_id) OR app.is_bl_client(id));
CREATE POLICY transaction_bls_select ON public.transaction_bls FOR SELECT TO authenticated
  USING (app.can_read_transaction(transaction_id));
REVOKE ALL ON public.customs_declarations, public.bills_of_lading, public.transaction_bls FROM authenticated;
GRANT SELECT ON public.transaction_bls TO authenticated;
-- fail closed: a column added later is not selectable until it is added here
DO $$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('customs_declarations', ARRAY['notes','cancel_reason']),
      ('bills_of_lading',      ARRAY['notes'])) AS x(tbl, hidden)
  LOOP
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND NOT (c.column_name = ANY (r.hidden));
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, r.tbl);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 12. function privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.norm_code(text), app.pdate(jsonb, text), app.norm_name(text), app.name_sim(text, text), app.g3_mirroring(),
  app.g3_lock_tx(uuid, text[]), app.tg_parties_before(), app.tg_fleet_before(), app.tg_client_aliases_before(),
  app.decl_fields(jsonb), app.decl_no_check(uuid, uuid, text, uuid, boolean), app.decl_json(public.customs_declarations),
  app.decl_event(public.customs_declarations, text, text, text, jsonb), app.decl_insert(public.transactions, jsonb, boolean),
  app.sync_tx_declaration(uuid), app.tg_declarations_mirror(),
  app.sync_tx_bl(uuid), app.tg_transaction_bls_mirror(), app.tg_bills_of_lading_mirror(),
  app.bl_event(public.transactions, public.bills_of_lading, text, text, jsonb), app.bl_link(public.transactions, uuid, boolean),
  app.bl_fields(jsonb), app.tg_containers_g3_before(), app.tg_containers_g3_event(),
  app.adopt_tx_declaration(public.transactions, text), app.adopt_tx_bl(public.transactions, text),
  app.tg_transactions_g3_adopt(), app.is_bl_client(uuid), app.can_read_bl(uuid, uuid)
FROM PUBLIC, anon, authenticated;
-- policy helpers (run as the caller)
GRANT EXECUTE ON FUNCTION app.is_bl_client(uuid), app.can_read_bl(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION
  public.match_client(uuid, jsonb),
  public.add_declaration(uuid, jsonb, uuid), public.set_declaration_status(uuid, text, text),
  public.cancel_declaration(uuid, text, jsonb), public.correct_declaration(uuid, jsonb, text),
  public.save_bl(jsonb, uuid), public.link_bl(uuid, uuid, boolean), public.unlink_bl(uuid, uuid, text),
  public.container_history(uuid, text), public.transaction_completeness(uuid),
  public.staff_internal_fields(text, uuid[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.match_client(uuid, jsonb),
  public.add_declaration(uuid, jsonb, uuid), public.set_declaration_status(uuid, text, text),
  public.cancel_declaration(uuid, text, jsonb), public.correct_declaration(uuid, jsonb, text),
  public.save_bl(jsonb, uuid), public.link_bl(uuid, uuid, boolean), public.unlink_bl(uuid, uuid, text),
  public.container_history(uuid, text), public.transaction_completeness(uuid),
  public.staff_internal_fields(text, uuid[])
TO authenticated;
