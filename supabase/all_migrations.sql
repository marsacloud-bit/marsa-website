-- Marsa staging: all migrations in order (generated from supabase/migrations). Paste into Supabase SQL Editor and Run.
-- FOR AN EMPTY DATABASE (first install) ONLY. A live staging DB that already has G3 uses g4_apply.sql (the G4 file alone):
-- replaying G3 A here narrows transaction_events_event_type_check and aborts once any G4 'finance' event exists.
DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;

-- ===== migrations/20261031000100_core_tenancy.sql =====
-- =====================================================================
-- Marsa (مرسى) — STAGING / PROTOTYPE schema. Test data only. Not production.
-- 0100 — SaaS core: organizations → branches → profiles → memberships,
--        per-org reference counters, status dictionaries (ar/en labels).
-- Idempotent where reasonable (IF NOT EXISTS / OR REPLACE / ON CONFLICT).
-- See docs/online/ARCHITECTURE.md.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS 'Marsa internal helpers (RLS helpers, triggers, validation). Not exposed through the API.';
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- true when the statement comes straight from the API (PostgREST roles),
-- false inside SECURITY DEFINER RPCs / migrations / seed (current_user = owner).
CREATE OR REPLACE FUNCTION app.is_api_caller() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT current_user IN ('anon', 'authenticated')
$$;

-- Fixed role catalogue (vision §8.2). Kept as text + CHECK so the list can
-- grow without enum migrations; labels live in public.status_labels(domain='role').
CREATE OR REPLACE FUNCTION app.all_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['client','clearance_staff','transport_staff','accountant','accounts_manager',
               'operations_manager','supervisor','admin']
$$;
CREATE OR REPLACE FUNCTION app.staff_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','accountant','accounts_manager',
               'operations_manager','supervisor','admin']
$$;
-- may create/edit clients, requests, transactions
CREATE OR REPLACE FUNCTION app.ops_writer_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','operations_manager','supervisor','admin']
$$;
-- may edit containers / transport data
CREATE OR REPLACE FUNCTION app.transport_writer_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','operations_manager','supervisor','admin']
$$;
CREATE OR REPLACE FUNCTION app.finance_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accountant','accounts_manager','admin']
$$;

-- ---------------------------------------------------------------------
-- organizations (tenant)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name_ar               text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 160),
  name_en               text CHECK (char_length(name_en) <= 160),
  ref_prefix            text NOT NULL DEFAULT 'MRS' CHECK (ref_prefix ~ '^[A-Z]{2,5}$'),
  environment           text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  public_intake_enabled boolean NOT NULL DEFAULT true,
  default_locale        text NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar','en')),
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.organizations IS 'Tenant (مؤسسة). STAGING: environment must stay ''staging'' in this project.';

-- ---------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name_ar    text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 120),
  name_en    text CHECK (char_length(name_en) <= 120),
  city       text CHECK (char_length(city) <= 80),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  UNIQUE (id, org_id)            -- target for tenant-consistent composite FKs
);

-- ---------------------------------------------------------------------
-- profiles (1:1 auth.users)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  text CHECK (char_length(full_name) <= 120),
  phone      text CHECK (char_length(phone) <= 20),
  locale     text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.profiles IS 'One row per auth user. Roles are NEVER taken from signup metadata; see memberships.';

-- ---------------------------------------------------------------------
-- memberships (user × org × optional branch × role)
-- branch_id NULL = all branches of the org.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id  uuid,
  role       text NOT NULL CHECK (role = ANY (app.all_roles())),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT memberships_client_no_branch CHECK (role <> 'client' OR branch_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_unique_idx
  ON public.memberships (user_id, org_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), role);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON public.memberships (user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS memberships_org_idx ON public.memberships (org_id);

-- ---------------------------------------------------------------------
-- per-org reference counters  →  MRS-2026-000123 / REQ-2026-000045
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_counters (
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('transaction','request','message','import')),
  year       int  NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, scope, year)
);

CREATE OR REPLACE FUNCTION app.next_ref(p_org uuid, p_scope text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year   int := extract(year FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int;
  v_n      bigint;
  v_prefix text;
BEGIN
  SELECT CASE p_scope
           WHEN 'transaction' THEN o.ref_prefix
           WHEN 'request'     THEN 'REQ'
           WHEN 'message'     THEN 'MSG'
           WHEN 'import'      THEN 'IMP'
         END
    INTO v_prefix
    FROM public.organizations o WHERE o.id = p_org;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_NOT_FOUND', DETAIL = 'organization';
  END IF;
  INSERT INTO public.org_counters AS c (org_id, scope, year, last_value)
  VALUES (p_org, p_scope, v_year, 1)
  ON CONFLICT (org_id, scope, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN v_prefix || '-' || v_year::text || '-' || lpad(v_n::text, 6, '0');
END $$;

-- ---------------------------------------------------------------------
-- status / code dictionaries with bilingual labels (RTL/LTR readiness)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.status_labels (
  domain         text NOT NULL,
  code           text NOT NULL,
  sort           int  NOT NULL,
  label_ar       text NOT NULL,
  label_en       text NOT NULL,
  client_visible boolean NOT NULL DEFAULT true,
  PRIMARY KEY (domain, code)
);
COMMENT ON TABLE public.status_labels IS 'Central dictionary of codes → ar/en labels. UI must read labels from here (or a translation file), not hardcode them.';

INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  -- vision §6.3 — the 10 operational stages
  ('operational_status','new',1,'جديدة','New',true),
  ('operational_status','in_progress',2,'قيد العمل','In progress',true),
  ('operational_status','customs_declaration',3,'البيان الجمركي','Customs declaration',true),
  ('operational_status','appointment',4,'الموعد','Appointment',true),
  ('operational_status','transport',5,'النقل','Transport',true),
  ('operational_status','empty_return',6,'إعادة الحاوية الفارغة','Empty container return',true),
  ('operational_status','operationally_complete',7,'منتهية تشغيليًا','Operationally complete',true),
  ('operational_status','under_billing',8,'تحت الفوترة','Under billing',true),
  ('operational_status','billed',9,'تمت الفوترة','Billed',true),
  ('operational_status','closed',10,'مغلقة','Closed',true),
  -- financial status: PLACEHOLDER until G4 (no ledger / invoicing in this release)
  ('financial_status','not_started',1,'لم تبدأ','Not started',false),
  ('financial_status','estimate_only',2,'تقدير غير ضريبي فقط','Non-tax estimate only',false),
  ('financial_status','draft_pending',3,'مسودة قيد الإعداد','Draft pending',false),
  ('financial_status','invoiced',4,'صدرت الفاتورة (خارج النظام)','Invoiced (external)',false),
  ('financial_status','settled',5,'مسددة','Settled',false),
  -- service request intake
  ('request_status','new',1,'جديد','New',true),
  ('request_status','under_review',2,'قيد المراجعة','Under review',true),
  ('request_status','converted',3,'تحوّل إلى معاملة','Converted to transaction',true),
  ('request_status','rejected',4,'مرفوض','Rejected',true),
  -- per-container empty return (G0-004, EV-01/02, D-09)
  ('container_return_status','pending',1,'بانتظار الإرجاع','Pending return',true),
  ('container_return_status','evidence_submitted',2,'دليل مرفوع بانتظار التحقق','Evidence submitted',true),
  ('container_return_status','returned_verified',3,'أُرجعت (دليل استلام موثّق)','Returned (verified receipt)',true),
  ('container_return_status','disputed',4,'دليل غامض — مراجعة بشرية','Disputed — human review',true),
  ('container_return_status','waived',5,'لا يلزم إرجاع (استثناء موثّق)','Waived (documented exception)',true),
  -- document kinds (vision §7.3 + evidence review §4)
  ('document_kind','bill_of_lading',1,'بوليصة الشحن','Bill of lading',true),
  ('document_kind','commercial_invoice',2,'الفاتورة التجارية','Commercial invoice',true),
  ('document_kind','packing_list',3,'قائمة التعبئة','Packing list',true),
  ('document_kind','certificate_of_origin',4,'شهادة المنشأ','Certificate of origin',true),
  ('document_kind','saber_certificate',5,'شهادة سابر','SABER certificate',true),
  ('document_kind','customs_declaration',6,'البيان الجمركي','Customs declaration',true),
  ('document_kind','delivery_order',7,'إذن التسليم','Delivery order',true),
  ('document_kind','appointment',8,'مستند موعد','Appointment document',true),
  ('document_kind','container_delivery_eir',9,'إيصال تسليم الحاوية الممتلئة (EIR)','Container delivery EIR',true),
  ('document_kind','empty_return_note',10,'تعليمات إرجاع الفارغ (ليست إثباتًا)','Empty return note (instruction, not proof)',true),
  ('document_kind','empty_return_receipt',11,'إيصال استلام الفارغ من الساحة/المشغل','Empty gate-in receipt',true),
  ('document_kind','operator_invoice',12,'فاتورة مشغل/مورد','Operator / supplier invoice',false),
  ('document_kind','government_doc',13,'مستند حكومي','Government document',true),
  ('document_kind','import_file',14,'ملف رفع جماعي','Bulk import file',false),
  ('document_kind','other',15,'مستند آخر','Other',true),
  ('classification_status','unreviewed',1,'لم يُراجع','Unreviewed',false),
  ('classification_status','confirmed',2,'تصنيف مؤكد','Confirmed',false),
  ('classification_status','reclassified',3,'أعيد تصنيفه','Reclassified',false),
  ('classification_status','ambiguous',4,'غامض — يحتاج مراجعة','Ambiguous',false),
  ('contact_status','new',1,'جديدة','New',false),
  ('contact_status','in_progress',2,'قيد المعالجة','In progress',false),
  ('contact_status','closed',3,'مغلقة','Closed',false),
  ('import_row_status','pending',1,'بانتظار التحقق','Pending',false),
  ('import_row_status','valid',2,'صالح','Valid',false),
  ('import_row_status','error',3,'به أخطاء','Error',false),
  ('import_row_status','duplicate',4,'مكرر محتمل — قرار بشري','Possible duplicate',false),
  ('import_row_status','committed',5,'تحوّل إلى طلب','Committed',false),
  ('import_row_status','skipped',6,'تم تجاهله','Skipped',false),
  ('role','client',1,'عميل','Client',false),
  ('role','clearance_staff',2,'موظف تخليص','Clearance staff',false),
  ('role','transport_staff',3,'موظف نقل','Transport staff',false),
  ('role','accountant',4,'محاسب','Accountant',false),
  ('role','accounts_manager',5,'مدير حسابات','Accounts manager',false),
  ('role','operations_manager',6,'مدير عمليات','Operations manager',false),
  ('role','supervisor',7,'مشرف','Supervisor',false),
  ('role','admin',8,'مدير نظام','System admin',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

CREATE OR REPLACE FUNCTION app.is_code(p_domain text, p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.status_labels s WHERE s.domain = p_domain AND s.code = p_code)
$$;
CREATE OR REPLACE FUNCTION app.code_sort(p_domain text, p_code text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.sort FROM public.status_labels s WHERE s.domain = p_domain AND s.code = p_code
$$;

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_touch ON public.organizations;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch ON public.branches;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch ON public.profiles;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch ON public.memberships;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- signup → profile (no role is granted here; staff/admin add memberships)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_meta jsonb := coalesce(NEW.raw_user_meta_data, '{}'::jsonb);
  v_locale text := CASE WHEN v_meta->>'locale' = 'en' THEN 'en' ELSE 'ar' END;
BEGIN
  INSERT INTO public.profiles (id, full_name, phone, locale)
  VALUES (NEW.id,
          left(nullif(btrim(v_meta->>'full_name'), ''), 120),
          left(nullif(btrim(v_meta->>'phone'), ''), 20),
          v_locale)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.handle_new_user();

-- ===== migrations/20261031000200_operations.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0200 — operational master data & hub.
-- clients, client_users, import_batches, import_rows, service_requests,
-- transactions (hub), documents, containers, transaction_events (append-only),
-- contact_messages, audit_log (append-only).
-- Tenant consistency: every child carries org_id and references its parent
-- through a composite FK (parent_id, org_id) so cross-tenant links are impossible.
-- NO accounting / ledger / tax-invoice tables here (out of scope until G4+).
-- =====================================================================

CREATE OR REPLACE FUNCTION app.document_kinds() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['bill_of_lading','commercial_invoice','packing_list','certificate_of_origin','saber_certificate',
               'customs_declaration','delivery_order','appointment','container_delivery_eir','empty_return_note',
               'empty_return_receipt','operator_invoice','government_doc','import_file','other']
$$;

-- ---------------------------------------------------------------------
-- clients (independent master record, vision §5)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_type            text NOT NULL CHECK (client_type IN ('individual','business')),
  name_ar                text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 160),
  name_en                text CHECK (char_length(name_en) <= 160),
  contact_person         text CHECK (char_length(contact_person) <= 120),
  classification         text CHECK (char_length(classification) <= 60),
  cr_number              text CHECK (cr_number ~ '^[0-9]{10}$'),
  vat_number             text CHECK (vat_number ~ '^[0-9]{15}$'),
  phone                  text CHECK (phone ~ '^0[0-9]{9}$'),
  email                  text CHECK (char_length(email) <= 160 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  preferred_contact      text CHECK (preferred_contact IN ('phone','whatsapp','email')),
  -- full national address (العنوان الوطني الكامل): building_no, street, district, city, postal_code, additional_no, unit_no
  national_address       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(national_address) = 'object'),
  -- short national address (العنوان المختصر) e.g. RRRD2929 — the only address printed on sales invoices (§5.1)
  national_address_short text CHECK (national_address_short ~ '^[A-Z]{4}[0-9]{4}$'),
  notes                  text CHECK (char_length(notes) <= 2000),
  is_active              boolean NOT NULL DEFAULT true,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
-- natural keys inside a tenant (arch-01)
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_cr_uidx  ON public.clients (org_id, cr_number)  WHERE cr_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_vat_uidx ON public.clients (org_id, vat_number) WHERE vat_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_org_name_idx ON public.clients (org_id, name_ar);

-- auth users of type "client" ↔ client record (portal access)
CREATE TABLE IF NOT EXISTS public.client_users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id  uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_users_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  UNIQUE (client_id, user_id)
);
CREATE INDEX IF NOT EXISTS client_users_user_idx ON public.client_users (user_id) WHERE is_active;

-- ---------------------------------------------------------------------
-- bulk import staging (arch-05, arch-11)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ref              text,
  client_id        uuid,
  kind             text NOT NULL DEFAULT 'shipments' CHECK (kind IN ('shipments')),
  file_name        text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_size        bigint CHECK (file_size >= 0),
  file_fingerprint text NOT NULL CHECK (file_fingerprint ~ '^[0-9a-f]{64}$'),  -- SHA-256 of the original file bytes
  sheet_names      text[] NOT NULL DEFAULT '{}',
  document_id      uuid,                                     -- optional: original file kept in storage
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed','cancelled')),
  total_rows       int NOT NULL DEFAULT 0,
  committed_rows   int NOT NULL DEFAULT 0,
  skipped_rows     int NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  committed_by     uuid,
  committed_at     timestamptz,
  CONSTRAINT import_batches_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS import_batches_fp_idx ON public.import_batches (org_id, file_fingerprint);

CREATE TABLE IF NOT EXISTS public.import_rows (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  batch_id           uuid NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  sheet_name         text NOT NULL DEFAULT '' CHECK (char_length(sheet_name) <= 120),
  row_no             int  NOT NULL CHECK (row_no > 0),
  source_row_id      text GENERATED ALWAYS AS (source_fingerprint || ':' || sheet_name || ':' || (row_no::text)) STORED,
  raw                jsonb NOT NULL,                       -- exactly as read from the file, never changed
  normalized         jsonb,                                -- flat keys = submit_service_request payload keys
  corrections        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{at, by, before, after}] appended by trigger
  validation_errors  jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_status         text NOT NULL DEFAULT 'pending' CHECK (row_status IN ('pending','valid','error','duplicate','committed','skipped')),
  duplicate_of       text,
  decision           text CHECK (decision IN ('accept','skip')),
  -- false once the batch is cancelled: a cancelled draft never produced requests,
  -- so its source ids are released for a later, correct re-import (history stays).
  is_live            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_rows_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.import_batches(id, org_id) ON DELETE CASCADE
);
-- unique source id per imported line (no duplicates) among live (draft/committed) batches
CREATE UNIQUE INDEX IF NOT EXISTS import_rows_source_uniq
  ON public.import_rows (org_id, source_fingerprint, sheet_name, row_no) WHERE is_live;
CREATE INDEX IF NOT EXISTS import_rows_batch_idx ON public.import_rows (batch_id, row_no);

-- ---------------------------------------------------------------------
-- service_requests (public intake; one request → at most one transaction)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id           uuid,
  ref                 text NOT NULL,
  status              text NOT NULL DEFAULT 'new' CHECK (status IN ('new','under_review','converted','rejected')),
  source              text NOT NULL DEFAULT 'web' CHECK (source IN ('web','portal','bulk','staff')),
  import_row_id       uuid UNIQUE REFERENCES public.import_rows(id),
  submitted_by        uuid,                 -- auth.uid() when submitted while signed in
  client_id           uuid,                 -- set when matched/linked by staff (never auto-trusted, D-02)
  tracking_token_hash text NOT NULL CHECK (tracking_token_hash ~ '^[0-9a-f]{64}$'),
  -- applicant (as typed; NOT the client master record)
  client_type         text CHECK (client_type IN ('individual','business')),
  full_name           text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 120),
  company             text CHECK (char_length(company) <= 160),
  phone               text NOT NULL CHECK (phone ~ '^0[0-9]{9}$'),
  email               text CHECK (char_length(email) <= 160),
  vat_number          text CHECK (vat_number ~ '^[0-9]{15}$'),
  cr_number           text CHECK (cr_number ~ '^[0-9]{10}$'),
  contact_pref        text CHECK (contact_pref IN ('phone','whatsapp','email')),
  -- shipment
  direction           text NOT NULL CHECK (direction IN ('import','export')),
  service             text CHECK (char_length(service) <= 40),
  mode                text NOT NULL CHECK (mode IN ('sea','air','land')),
  country             text CHECK (char_length(country) <= 80),
  port                text NOT NULL CHECK (char_length(port) BETWEEN 1 AND 80),
  goods               text NOT NULL CHECK (char_length(goods) BETWEEN 3 AND 1000),
  hs_code             text CHECK (hs_code ~ '^[0-9]{4,12}$'),
  declaration_no      text CHECK (char_length(declaration_no) <= 30),
  need_aci            boolean NOT NULL DEFAULT false,
  goods_value         numeric(16,2) CHECK (goods_value >= 0),
  currency            text CHECK (currency IN ('SAR','USD','EUR','CNY','AED')),
  weight_kg           numeric(14,3) CHECK (weight_kg >= 0),
  container_type      text CHECK (container_type IN ('20ft','40ft','LCL')),
  container_numbers   text[] NOT NULL DEFAULT '{}',
  declared_count      int CHECK (declared_count BETWEEN 0 AND 10000),
  count_kind          text CHECK (count_kind IN ('containers','packages','trucks')),  -- arch-10
  bl_number           text CHECK (char_length(bl_number) <= 40),
  shipping_line       text CHECK (char_length(shipping_line) <= 80),
  eta                 date,
  docs_later          boolean NOT NULL DEFAULT false,
  declared_documents  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{kind,name,size}] names only; files go to documents
  estimate            jsonb,                                -- calculator estimate: NON-tax, informational (arch-08)
  notes               text CHECK (char_length(notes) <= 2000),
  terms_accepted_at   timestamptz,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  status_note         text CHECK (char_length(status_note) <= 1000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_requests_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT service_requests_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT service_requests_ref_uniq UNIQUE (org_id, ref),
  CONSTRAINT service_requests_containers_max CHECK (coalesce(array_length(container_numbers, 1), 0) <= 200),
  UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS service_requests_queue_idx ON public.service_requests (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_phone_idx ON public.service_requests (org_id, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_bl_idx ON public.service_requests (org_id, bl_number) WHERE bl_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_requests_submitter_idx ON public.service_requests (submitted_by) WHERE submitted_by IS NOT NULL;

-- ---------------------------------------------------------------------
-- transactions — THE HUB (vision §2.2, §6)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL,
  client_id           uuid NOT NULL,
  request_id          uuid UNIQUE,
  ref                 text NOT NULL,                         -- MRS-2026-000123 (server-generated)
  operation           text NOT NULL CHECK (operation IN ('import','export')),
  mode                text NOT NULL CHECK (mode IN ('sea','air','land')),
  service             text CHECK (char_length(service) <= 40),
  port_of_loading     text CHECK (char_length(port_of_loading) <= 80),
  port_of_discharge   text CHECK (char_length(port_of_discharge) <= 80),
  country             text CHECK (char_length(country) <= 80),  -- origin (import) / destination (export)
  goods_description   text CHECK (char_length(goods_description) <= 1000),
  hs_code             text CHECK (hs_code ~ '^[0-9]{4,12}$'),
  shipping_line       text CHECK (char_length(shipping_line) <= 80),
  bl_number           text CHECK (char_length(bl_number) <= 40),  -- NOT unique: one B/L may feed several transactions
  declaration_no      text CHECK (char_length(declaration_no) <= 30),
  declaration_date    date,
  declaration_type    text CHECK (char_length(declaration_type) <= 40),
  container_count     int NOT NULL DEFAULT 0 CHECK (container_count >= 0),   -- numeric & aggregatable (§6.1)
  package_count       int CHECK (package_count >= 0),
  eta                 date,
  responsible_user_id uuid REFERENCES public.profiles(id),
  operational_status  text NOT NULL DEFAULT 'new' CHECK (operational_status IN
                        ('new','in_progress','customs_declaration','appointment','transport','empty_return',
                         'operationally_complete','under_billing','billed','closed')),
  financial_status    text NOT NULL DEFAULT 'not_started' CHECK (financial_status IN
                        ('not_started','estimate_only','draft_pending','invoiced','settled')),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  tracking_token_hash text CHECK (tracking_token_hash ~ '^[0-9a-f]{64}$'),
  notes               text CHECK (char_length(notes) <= 2000),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_branch_fk  FOREIGN KEY (branch_id, org_id)  REFERENCES public.branches(id, org_id),
  CONSTRAINT transactions_client_fk  FOREIGN KEY (client_id, org_id)  REFERENCES public.clients(id, org_id),
  CONSTRAINT transactions_request_fk FOREIGN KEY (request_id, org_id) REFERENCES public.service_requests(id, org_id),
  CONSTRAINT transactions_ref_uniq UNIQUE (org_id, ref),
  UNIQUE (id, org_id)
);
-- D-03: one transaction ↔ one official customs declaration number
CREATE UNIQUE INDEX IF NOT EXISTS transactions_declaration_uidx ON public.transactions (org_id, declaration_no) WHERE declaration_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_branch_status_idx ON public.transactions (org_id, branch_id, operational_status);
CREATE INDEX IF NOT EXISTS transactions_client_idx ON public.transactions (client_id);
CREATE INDEX IF NOT EXISTS transactions_bl_idx ON public.transactions (org_id, bl_number) WHERE bl_number IS NOT NULL;

-- ---------------------------------------------------------------------
-- documents — originals kept immutable with source & hash (arch-07)
-- storage_path = {org_id}/{transaction_id | r_<request_id>}/{document_id}/{file name}
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  transaction_id        uuid,
  request_id            uuid,
  kind                  text NOT NULL DEFAULT 'other',       -- declared by the uploader (a claim, not a fact)
  classification        text,                                -- verified by staff
  classification_status text NOT NULL DEFAULT 'unreviewed' CHECK (classification_status IN ('unreviewed','confirmed','reclassified','ambiguous')),
  classification_note   text CHECK (char_length(classification_note) <= 1000),
  classified_by         uuid,
  classified_at         timestamptz,
  storage_bucket        text NOT NULL DEFAULT 'documents',
  storage_path          text NOT NULL UNIQUE CHECK (char_length(storage_path) <= 512),
  sha256                text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_name         text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  mime_type             text CHECK (char_length(mime_type) <= 120),
  size_bytes            bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  version               int NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id         uuid REFERENCES public.documents(id),
  source                text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','staff_scan','email','whatsapp','import','system')),
  source_ref            text CHECK (char_length(source_ref) <= 255),  -- provenance (message id, sender, batch…)
  visibility            text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  uploaded_by           uuid NOT NULL,
  uploaded_at           timestamptz NOT NULL DEFAULT now(),
  voided_at             timestamptz,
  voided_by             uuid,
  void_reason           text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT documents_kind_chk CHECK (kind = ANY (app.document_kinds())),
  CONSTRAINT documents_classification_chk CHECK (classification IS NULL OR classification = ANY (app.document_kinds())),
  CONSTRAINT documents_owner_chk CHECK (transaction_id IS NOT NULL OR request_id IS NOT NULL),
  CONSTRAINT documents_tx_fk  FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT documents_req_fk FOREIGN KEY (request_id, org_id) REFERENCES public.service_requests(id, org_id),
  CONSTRAINT documents_path_chk CHECK (
    split_part(storage_path, '/', 1) = org_id::text
    AND ( (transaction_id IS NOT NULL AND split_part(storage_path, '/', 2) = transaction_id::text)
       OR (request_id IS NOT NULL AND split_part(storage_path, '/', 2) = 'r_' || request_id::text) )
    AND split_part(storage_path, '/', 3) = id::text
    AND split_part(storage_path, '/', 4) <> ''
    AND storage_path NOT LIKE '%..%'
  ),
  CONSTRAINT documents_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
-- same bytes twice on the same transaction/request = duplicate upload
CREATE UNIQUE INDEX IF NOT EXISTS documents_dedupe_uidx
  ON public.documents (org_id, coalesce(transaction_id, request_id), sha256) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_tx_idx ON public.documents (transaction_id);
CREATE INDEX IF NOT EXISTS documents_req_idx ON public.documents (request_id);

-- ---------------------------------------------------------------------
-- containers — one row per container per transaction (container visit).
-- The number can repeat across transactions/time (DEC-02); unique per transaction.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.containers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  transaction_id       uuid NOT NULL,
  container_no         text NOT NULL CHECK (container_no ~ '^[A-Z]{4}[0-9]{7}$'),
  container_type       text CHECK (container_type IN ('20ft','40ft','40hc','45ft','20rf','40rf','LCL','other')),
  gate_out_at          timestamptz,
  delivered_at         timestamptz,
  return_deadline      date,                         -- e.g. "EMPTY RETURN By" on the EIR = a deadline, not proof
  return_location      text CHECK (char_length(return_location) <= 120),
  return_status        text NOT NULL DEFAULT 'pending' CHECK (return_status IN ('pending','evidence_submitted','returned_verified','disputed','waived')),
  returned_at          timestamptz,
  evidence_document_id uuid,
  verified_by          uuid,
  verified_at          timestamptz,
  waiver_reason        text CHECK (char_length(waiver_reason) <= 500),
  notes                text CHECK (char_length(notes) <= 1000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT containers_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT containers_evidence_fk FOREIGN KEY (evidence_document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT containers_tx_no_uniq UNIQUE (transaction_id, container_no),
  CONSTRAINT containers_verified_chk CHECK (
    return_status <> 'returned_verified'
    OR (evidence_document_id IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND returned_at IS NOT NULL)),
  CONSTRAINT containers_evidence_needed_chk CHECK (
    return_status NOT IN ('evidence_submitted','disputed') OR evidence_document_id IS NOT NULL),
  CONSTRAINT containers_waiver_chk CHECK (return_status <> 'waived' OR waiver_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS containers_no_idx ON public.containers (org_id, container_no);
CREATE INDEX IF NOT EXISTS containers_open_idx ON public.containers (org_id, return_deadline) WHERE return_status IN ('pending','evidence_submitted','disputed');

-- ---------------------------------------------------------------------
-- transaction_events — append-only timeline (corrections add rows, never edit)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transaction_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            uuid NOT NULL,
  transaction_id    uuid NOT NULL,
  event_type        text NOT NULL CHECK (event_type IN
                      ('created','request_converted','operational_status','financial_status',
                       'container_return','document','note','tracking_token')),
  from_status       text,
  to_status         text,
  note              text CHECK (char_length(note) <= 2000),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible_to_client boolean NOT NULL DEFAULT false,
  actor             uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_events_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id)
);
CREATE INDEX IF NOT EXISTS transaction_events_tx_idx ON public.transaction_events (transaction_id, created_at);

-- ---------------------------------------------------------------------
-- contact_messages (public, via RPC only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ref        text NOT NULL,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  company    text CHECK (char_length(company) <= 160),
  phone      text NOT NULL CHECK (phone ~ '^0[0-9]{9}$'),
  email      text NOT NULL CHECK (char_length(email) <= 160),
  subject    text NOT NULL CHECK (subject IN ('quote','aci','saber','hs','duties','tracking','export','partnership','complaint','other')),
  reference  text CHECK (char_length(reference) <= 40),
  message    text NOT NULL CHECK (char_length(message) BETWEEN 15 AND 1000),
  preferred  text NOT NULL DEFAULT 'phone' CHECK (preferred IN ('phone','whatsapp','email')),
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','closed')),
  handled_by uuid,
  handled_at timestamptz,
  submitted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_messages_ref_uniq UNIQUE (org_id, ref)
);
CREATE INDEX IF NOT EXISTS contact_messages_queue_idx ON public.contact_messages (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_messages_phone_idx ON public.contact_messages (org_id, phone, created_at DESC);

-- ---------------------------------------------------------------------
-- audit_log — generic row-change trail (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         uuid,
  table_name     text NOT NULL,
  row_id         text,
  action         text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  changed_fields text[],
  old_data       jsonb,
  new_data       jsonb,
  actor          uuid,
  actor_role     text,
  db_user        text NOT NULL DEFAULT current_user,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON public.audit_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_row_idx ON public.audit_log (table_name, row_id);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','client_users','import_batches','import_rows','service_requests',
                           'transactions','containers','contact_messages']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
  END LOOP;
END $$;

-- ===== migrations/20261031000300_security_rls.sql =====
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

-- ===== migrations/20261031000400_rpc.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0400 — RPCs (PostgREST: POST /rest/v1/rpc/<name>)
--
-- Public (anon + authenticated):
--   submit_service_request(payload jsonb)        → {ref, tracking_token, status, created_at}
--   submit_contact_message(payload jsonb)        → {ref, created_at}
--   public_track(p_ref text, p_token text)       → minimal status timeline (no personal data)
-- Signed-in:
--   my_context()                                 → {user_id, profile, memberships[], client_ids[]}
--   set_request_status(p_request_id, p_status, p_note)                (ops staff)
--   convert_request_to_transaction(p_request_id, p_branch_id, p_client_id) (ops staff)
--   set_transaction_status(p_transaction_id, p_status, p_note)        (role per target stage)
--   set_financial_status(p_transaction_id, p_status, p_note)          (finance roles; placeholder)
--   issue_tracking_token(p_transaction_id)                            (ops staff)
--   import_commit(p_batch_id)                                         (batch creator or ops staff)
--
-- Errors: RAISE … MESSAGE = 'MRS_<CODE>', DETAIL = <field>. The frontend maps
-- codes to Arabic text (assets/js/supa.js). Never echo user input in errors.
-- =====================================================================

-- ---------------------------------------------------------------------
-- small pure helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.to_western(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(p, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')
$$;

CREATE OR REPLACE FUNCTION app.digits(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(regexp_replace(app.to_western(coalesce(p, '')), '[^0-9]', '', 'g'), '')
$$;

-- Saudi phone → 05XXXXXXXX (mobile) or 01XXXXXXXX (landline when allowed); NULL when invalid
CREATE OR REPLACE FUNCTION app.norm_phone(p text, p_allow_landline boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := regexp_replace(app.to_western(coalesce(p, '')), '[[:space:]().-]', '', 'g');
BEGIN
  IF v LIKE '+966%' THEN v := '0' || substr(v, 5);
  ELSIF v LIKE '00966%' THEN v := '0' || substr(v, 6);
  ELSIF v LIKE '966%' AND length(v) IN (11, 12) THEN v := '0' || substr(v, 4);
  END IF;
  IF v ~ '^5[0-9]{8}$' THEN v := '0' || v; END IF;
  IF v ~ '^05[0-9]{8}$' THEN RETURN v; END IF;
  IF p_allow_landline AND v ~ '^01[1-7][0-9]{7}$' THEN RETURN v; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.is_email(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND char_length(p) <= 160 AND p ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
$$;

-- 256-bit random token (hex). Only its SHA-256 is stored.
CREATE OR REPLACE FUNCTION app.new_token() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;
CREATE OR REPLACE FUNCTION app.hash_token(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- read a trimmed text field from a jsonb payload with length/required checks
CREATE OR REPLACE FUNCTION app.ptext(p jsonb, k text, p_max int, p_required boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text;
BEGIN
  IF jsonb_typeof(p -> k) IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  v := nullif(btrim(regexp_replace(coalesce(p ->> k, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
  IF v IS NULL AND p_required THEN PERFORM app.fail('MRS_REQUIRED', k); END IF;
  IF char_length(v) > p_max THEN PERFORM app.fail('MRS_TOO_LONG', k); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.pbool(p jsonb, k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(coalesce(p ->> k, '')) IN ('true','1','on','yes')
$$;

CREATE OR REPLACE FUNCTION app.pnum(p jsonb, k text, p_max numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE s text := nullif(replace(app.to_western(btrim(coalesce(p ->> k, ''))), ',', ''), ''); v numeric;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF s !~ '^[0-9]+(\.[0-9]+)?$' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  v := s::numeric;
  IF v > p_max THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------
-- core intake insert (shared by submit_service_request and import_commit)
-- payload keys (flat, = request.html field names):
--   fullName company phone email clientType taxId crNumber contactPref
--   direction service mode country port goods hsCode declarationNo needAci
--   value currency weight containerType containerNumbers(array|string) count
--   blNumber shippingLine eta(YYYY-MM-DD) docsLater notes documents[] calc{} terms branchCode
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.insert_service_request(
  p_org uuid, p jsonb, p_source text, p_submitted_by uuid, p_client_id uuid, p_import_row_id uuid,
  OUT id uuid, OUT ref text, OUT token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_web       boolean := p_source IN ('web','portal');
  v_phone     text;
  v_email     text;
  v_company   text;
  v_ctype     text;
  v_vat       text;
  v_cr        text;
  v_dir       text;
  v_mode      text;
  v_service   text;
  v_ctr_type  text;
  v_ctrs      text[] := '{}';
  v_raw_ctrs  text;
  v_count     int;
  v_count_kind text;
  v_eta       date;
  v_hs        text;
  v_docs      jsonb := '[]'::jsonb;
  v_calc      jsonb;
  v_branch    uuid;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  IF length(p::text) > 30000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;

  -- applicant
  PERFORM app.ptext(p, 'fullName', 120, true);
  IF char_length(app.ptext(p, 'fullName', 120)) < 3 THEN PERFORM app.fail('MRS_INVALID', 'fullName'); END IF;
  v_phone := app.norm_phone(app.ptext(p, 'phone', 25, true));
  IF v_phone IS NULL THEN PERFORM app.fail('MRS_INVALID', 'phone'); END IF;
  v_email := lower(app.ptext(p, 'email', 160, v_web));
  IF v_email IS NOT NULL AND NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  v_company := app.ptext(p, 'company', 160, v_web);
  v_ctype := app.ptext(p, 'clientType', 20);
  IF v_ctype IS NOT NULL AND v_ctype NOT IN ('individual','business') THEN PERFORM app.fail('MRS_INVALID', 'clientType'); END IF;
  v_vat := app.digits(app.ptext(p, 'taxId', 30));
  IF v_vat IS NOT NULL AND v_vat !~ '^[0-9]{15}$' THEN PERFORM app.fail('MRS_INVALID', 'taxId'); END IF;
  v_cr := app.digits(app.ptext(p, 'crNumber', 30));
  IF v_cr IS NOT NULL AND v_cr !~ '^[0-9]{10}$' THEN PERFORM app.fail('MRS_INVALID', 'crNumber'); END IF;
  IF app.ptext(p, 'contactPref', 20) IS NOT NULL AND app.ptext(p, 'contactPref', 20) NOT IN ('phone','whatsapp','email') THEN
    PERFORM app.fail('MRS_INVALID', 'contactPref');
  END IF;

  -- shipment
  v_dir := app.ptext(p, 'direction', 10, true);
  IF v_dir NOT IN ('import','export') THEN PERFORM app.fail('MRS_INVALID', 'direction'); END IF;
  v_mode := app.ptext(p, 'mode', 10, true);
  IF v_mode NOT IN ('sea','air','land') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  v_service := app.ptext(p, 'service', 40, v_web);
  IF v_service IS NOT NULL AND v_service NOT IN ('clearance','aci','hs','inspection','door','freight','consult') THEN
    PERFORM app.fail('MRS_INVALID', 'service');
  END IF;
  PERFORM app.ptext(p, 'country', 80, v_web);
  PERFORM app.ptext(p, 'port', 80, true);
  PERFORM app.ptext(p, 'goods', 1000, true);
  IF char_length(app.ptext(p, 'goods', 1000)) < 3 THEN PERFORM app.fail('MRS_INVALID', 'goods'); END IF;
  v_hs := app.digits(app.ptext(p, 'hsCode', 20));
  IF v_hs IS NOT NULL AND v_hs !~ '^[0-9]{4,12}$' THEN PERFORM app.fail('MRS_INVALID', 'hsCode'); END IF;
  IF app.ptext(p, 'currency', 3) IS NOT NULL AND app.ptext(p, 'currency', 3) NOT IN ('SAR','USD','EUR','CNY','AED') THEN
    PERFORM app.fail('MRS_INVALID', 'currency');
  END IF;

  v_ctr_type := CASE WHEN v_mode = 'sea' THEN app.ptext(p, 'containerType', 10) END;
  IF v_ctr_type IS NOT NULL AND v_ctr_type NOT IN ('20ft','40ft','LCL') THEN PERFORM app.fail('MRS_INVALID', 'containerType'); END IF;

  -- container numbers: JSON array or free text "MSCU1234565, TGHU7304186"
  IF jsonb_typeof(p -> 'containerNumbers') = 'array' THEN
    SELECT string_agg(x, ',') INTO v_raw_ctrs FROM jsonb_array_elements_text(p -> 'containerNumbers') x;
  ELSE
    v_raw_ctrs := p ->> 'containerNumbers';
  END IF;
  IF char_length(v_raw_ctrs) > 4000 THEN PERFORM app.fail('MRS_TOO_LONG', 'containerNumbers'); END IF;
  IF v_mode = 'sea' AND nullif(btrim(coalesce(v_raw_ctrs, '')), '') IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO v_ctrs
      FROM regexp_matches(upper(regexp_replace(app.to_western(v_raw_ctrs), '[[:space:]/-]', '', 'g')), '([A-Z]{4}[0-9]{7})', 'g') m;
    -- anything left after removing valid numbers and separators is invalid input
    IF regexp_replace(upper(regexp_replace(app.to_western(v_raw_ctrs), '[[:space:]/-]', '', 'g')), '([A-Z]{4}[0-9]{7})|[,،;]', '', 'g') <> '' THEN
      PERFORM app.fail('MRS_INVALID', 'containerNumbers');
    END IF;
    IF array_length(v_ctrs, 1) > 200 THEN PERFORM app.fail('MRS_TOO_LONG', 'containerNumbers'); END IF;
  END IF;

  v_count := app.pnum(p, 'count', 10000)::int;
  v_count_kind := CASE WHEN v_mode = 'sea' AND coalesce(v_ctr_type, '') <> 'LCL' THEN 'containers'
                       WHEN v_mode = 'land' THEN 'trucks' ELSE 'packages' END;

  IF app.ptext(p, 'eta', 10) IS NOT NULL THEN
    IF app.ptext(p, 'eta', 10) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN PERFORM app.fail('MRS_INVALID', 'eta'); END IF;
    BEGIN v_eta := app.ptext(p, 'eta', 10)::date;
    EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', 'eta'); END;
  END IF;

  -- declared documents (names only) and the calculator estimate (non-tax)
  IF jsonb_typeof(p -> 'documents') = 'array' THEN
    IF jsonb_array_length(p -> 'documents') > 30 THEN PERFORM app.fail('MRS_TOO_LONG', 'documents'); END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'kind', left(d ->> 'kind', 40), 'name', left(d ->> 'name', 255),
             'size', CASE WHEN (d ->> 'size') ~ '^[0-9]{1,12}$' THEN (d ->> 'size')::bigint END)), '[]'::jsonb)
      INTO v_docs FROM jsonb_array_elements(p -> 'documents') d WHERE jsonb_typeof(d) = 'object';
  END IF;
  IF jsonb_typeof(p -> 'calc') = 'object' THEN
    IF length((p -> 'calc')::text) > 6000 THEN PERFORM app.fail('MRS_TOO_LONG', 'calc'); END IF;
    v_calc := (p -> 'calc') || jsonb_build_object('is_tax_document', false, 'kind', 'non_tax_estimate');
  END IF;

  IF v_web AND NOT app.pbool(p, 'terms') THEN PERFORM app.fail('MRS_REQUIRED', 'terms'); END IF;

  IF app.ptext(p, 'branchCode', 10) IS NOT NULL THEN
    SELECT b.id INTO v_branch FROM public.branches b
     WHERE b.org_id = p_org AND b.code = upper(app.ptext(p, 'branchCode', 10)) AND b.is_active;
  END IF;

  -- rate-limit-ish guard (public intake only)
  IF v_web THEN
    IF (SELECT count(*) FROM public.service_requests r
         WHERE r.org_id = p_org AND r.phone = v_phone AND r.created_at > now() - interval '1 hour') >= 5 THEN
      PERFORM app.fail('MRS_RATE_LIMITED', 'phone');
    END IF;
    IF (SELECT count(*) FROM public.service_requests r
         WHERE r.org_id = p_org AND r.source IN ('web','portal') AND r.created_at > now() - interval '10 minutes') >= 120 THEN
      PERFORM app.fail('MRS_RATE_LIMITED', 'org');
    END IF;
  END IF;

  token := app.new_token();
  ref := app.next_ref(p_org, 'request');
  INSERT INTO public.service_requests AS r (
    org_id, branch_id, ref, status, source, import_row_id, submitted_by, client_id, tracking_token_hash,
    client_type, full_name, company, phone, email, vat_number, cr_number, contact_pref,
    direction, service, mode, country, port, goods, hs_code, declaration_no, need_aci,
    goods_value, currency, weight_kg, container_type, container_numbers, declared_count, count_kind,
    bl_number, shipping_line, eta, docs_later, declared_documents, estimate, notes, terms_accepted_at)
  VALUES (
    p_org, v_branch, ref, 'new', p_source, p_import_row_id, p_submitted_by, p_client_id, app.hash_token(token),
    coalesce(v_ctype, CASE WHEN v_company IS NULL OR v_company = 'فرد' THEN 'individual' ELSE 'business' END),
    app.ptext(p, 'fullName', 120), v_company, v_phone, v_email, v_vat, v_cr, app.ptext(p, 'contactPref', 20),
    v_dir, v_service, v_mode, app.ptext(p, 'country', 80), app.ptext(p, 'port', 80), app.ptext(p, 'goods', 1000),
    v_hs, CASE WHEN v_dir = 'import' THEN app.ptext(p, 'declarationNo', 30) END,
    v_dir = 'import' AND app.pbool(p, 'needAci'),
    app.pnum(p, 'value', 9999999999999), app.ptext(p, 'currency', 3), app.pnum(p, 'weight', 99999999999),
    v_ctr_type, v_ctrs, v_count, v_count_kind,
    nullif(upper(regexp_replace(coalesce(app.ptext(p, 'blNumber', 40), ''), '[[:space:]]+', ' ', 'g')), ''),
    app.ptext(p, 'shippingLine', 80), v_eta, app.pbool(p, 'docsLater'), v_docs, v_calc,
    app.ptext(p, 'notes', 2000), CASE WHEN app.pbool(p, 'terms') THEN now() END)
  RETURNING r.id INTO id;
END $$;

-- ---------------------------------------------------------------------
-- PUBLIC: submit_service_request
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_service_request(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
  v_uid uuid := auth.uid();
  v_client uuid;
  v_res record;
BEGIN
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea') AND o.is_active;
  IF v_org.id IS NULL OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;

  -- a signed-in client may attach the request to one of their own client records
  IF v_uid IS NOT NULL AND (payload ->> 'clientId') ~ '^[0-9a-f-]{36}$' THEN
    SELECT c.id INTO v_client FROM public.clients c
     WHERE c.id = (payload ->> 'clientId')::uuid AND c.org_id = v_org.id AND app.is_client_user(c.id);
  END IF;

  SELECT * INTO v_res FROM app.insert_service_request(
    v_org.id, payload, CASE WHEN v_uid IS NULL THEN 'web' ELSE 'portal' END, v_uid, v_client, NULL);

  RETURN jsonb_build_object('ref', v_res.ref, 'tracking_token', v_res.token, 'status', 'new',
                            'created_at', now(), 'environment', v_org.environment);
END $$;

-- ---------------------------------------------------------------------
-- PUBLIC: submit_contact_message
-- payload keys: name company phone email subject reference message preferred consent
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_contact_message(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
  v_phone text;
  v_email text;
  v_subject text;
  v_pref text;
  v_ref text;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  IF length(payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea') AND o.is_active;
  IF v_org.id IS NULL OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;

  IF char_length(app.ptext(payload, 'name', 120, true)) < 3 THEN PERFORM app.fail('MRS_INVALID', 'name'); END IF;
  v_phone := app.norm_phone(app.ptext(payload, 'phone', 25, true), true);
  IF v_phone IS NULL THEN PERFORM app.fail('MRS_INVALID', 'phone'); END IF;
  v_email := lower(app.ptext(payload, 'email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  v_subject := app.ptext(payload, 'subject', 20, true);
  IF v_subject NOT IN ('quote','aci','saber','hs','duties','tracking','export','partnership','complaint','other') THEN
    PERFORM app.fail('MRS_INVALID', 'subject');
  END IF;
  IF char_length(app.ptext(payload, 'message', 1000, true)) < 15 THEN PERFORM app.fail('MRS_INVALID', 'message'); END IF;
  v_pref := coalesce(app.ptext(payload, 'preferred', 20), 'phone');
  IF v_pref NOT IN ('phone','whatsapp','email') THEN PERFORM app.fail('MRS_INVALID', 'preferred'); END IF;
  IF NOT app.pbool(payload, 'consent') THEN PERFORM app.fail('MRS_REQUIRED', 'consent'); END IF;

  IF (SELECT count(*) FROM public.contact_messages m
       WHERE m.org_id = v_org.id AND m.phone = v_phone AND m.created_at > now() - interval '1 hour') >= 5 THEN
    PERFORM app.fail('MRS_RATE_LIMITED', 'phone');
  END IF;
  IF (SELECT count(*) FROM public.contact_messages m
       WHERE m.org_id = v_org.id AND m.created_at > now() - interval '10 minutes') >= 120 THEN
    PERFORM app.fail('MRS_RATE_LIMITED', 'org');
  END IF;

  v_ref := app.next_ref(v_org.id, 'message');
  INSERT INTO public.contact_messages (org_id, ref, name, company, phone, email, subject, reference, message, preferred, submitted_by)
  VALUES (v_org.id, v_ref, app.ptext(payload, 'name', 120), app.ptext(payload, 'company', 160), v_phone, v_email,
          v_subject, app.ptext(payload, 'reference', 40), app.ptext(payload, 'message', 1000), v_pref, auth.uid());
  RETURN jsonb_build_object('ref', v_ref, 'created_at', now());
END $$;

-- ---------------------------------------------------------------------
-- PUBLIC: public_track(ref, token) — minimal, non-personal status view.
-- Same error for "unknown ref" and "wrong token" (no existence oracle).
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
-- my_context(): who am I, where, with which roles
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
        FROM public.client_users cu JOIN public.clients c ON c.id = cu.client_id AND c.is_active
       WHERE cu.user_id = v_uid AND cu.is_active), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------
-- set_request_status(request, 'under_review' | 'rejected' | 'new', note)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_request_status(p_request_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_req public.service_requests; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_req FROM public.service_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL OR NOT app.has_request_role(v_req.id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF p_status NOT IN ('new','under_review','rejected') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'status'); END IF;
  IF v_req.status = 'converted' THEN PERFORM app.fail('MRS_ALREADY_CONVERTED'); END IF;
  IF v_req.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF p_status = 'rejected' AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED'); END IF;
  IF char_length(v_note) > 1000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  UPDATE public.service_requests r
     SET status = p_status, status_note = coalesce(v_note, r.status_note), reviewed_by = auth.uid(), reviewed_at = now()
   WHERE r.id = v_req.id;
  RETURN jsonb_build_object('request_id', v_req.id, 'ref', v_req.ref, 'from', v_req.status, 'to', p_status);
END $$;

-- ---------------------------------------------------------------------
-- convert_request_to_transaction: request → (existing|new) client + transaction + containers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_request_to_transaction(
  p_request_id uuid, p_branch_id uuid DEFAULT NULL, p_client_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req public.service_requests;
  v_branch uuid;
  v_client uuid;
  v_client_created boolean := false;
  v_tx public.transactions;
  v_no text;
  v_n int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_req FROM public.service_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL OR NOT app.has_request_role(v_req.id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_req.status = 'converted' OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.request_id = v_req.id) THEN
    PERFORM app.fail('MRS_ALREADY_CONVERTED');
  END IF;
  IF v_req.status = 'rejected' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'rejected'); END IF;

  v_branch := coalesce(p_branch_id, v_req.branch_id);
  IF v_branch IS NULL THEN PERFORM app.fail('MRS_BRANCH_REQUIRED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = v_req.org_id AND b.is_active)
     OR NOT app.has_branch_role(v_req.org_id, v_branch, app.ops_writer_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'branch');
  END IF;

  -- client master: explicit → request link → natural key (CR / VAT) → new record
  IF p_client_id IS NOT NULL THEN
    SELECT c.id INTO v_client FROM public.clients c WHERE c.id = p_client_id AND c.org_id = v_req.org_id;
    IF v_client IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  ELSIF v_req.client_id IS NOT NULL THEN
    v_client := v_req.client_id;
  ELSE
    SELECT c.id INTO v_client FROM public.clients c
     WHERE c.org_id = v_req.org_id
       AND ((v_req.cr_number IS NOT NULL AND c.cr_number = v_req.cr_number)
         OR (v_req.vat_number IS NOT NULL AND c.vat_number = v_req.vat_number))
     ORDER BY (c.cr_number = v_req.cr_number) DESC NULLS LAST LIMIT 1;
    IF v_client IS NULL THEN
      INSERT INTO public.clients (org_id, client_type, name_ar, contact_person, cr_number, vat_number, phone, email,
                                  preferred_contact, created_by, notes)
      VALUES (v_req.org_id, coalesce(v_req.client_type, 'business'),
              CASE WHEN v_req.client_type = 'individual' OR v_req.company IS NULL OR v_req.company = 'فرد'
                   THEN v_req.full_name ELSE v_req.company END,
              v_req.full_name, v_req.cr_number, v_req.vat_number, v_req.phone,
              CASE WHEN app.is_email(v_req.email) THEN v_req.email END,
              v_req.contact_pref, auth.uid(), 'أُنشئ من طلب الخدمة ' || v_req.ref)
      RETURNING id INTO v_client;
      v_client_created := true;
    END IF;
  END IF;

  INSERT INTO public.transactions (
    org_id, branch_id, client_id, request_id, operation, mode, service,
    port_of_loading, port_of_discharge, country, goods_description, hs_code, shipping_line, bl_number,
    declaration_no, container_count, package_count, eta, responsible_user_id, created_by)
  VALUES (
    v_req.org_id, v_branch, v_client, v_req.id, v_req.direction, v_req.mode, v_req.service,
    CASE WHEN v_req.direction = 'export' THEN v_req.port END,
    CASE WHEN v_req.direction = 'import' THEN v_req.port END,
    v_req.country, v_req.goods, v_req.hs_code, v_req.shipping_line, v_req.bl_number,
    v_req.declaration_no,
    greatest(coalesce(array_length(v_req.container_numbers, 1), 0),
             CASE WHEN v_req.count_kind = 'containers' THEN coalesce(v_req.declared_count, 0) ELSE 0 END),
    CASE WHEN v_req.count_kind = 'packages' THEN v_req.declared_count END,
    v_req.eta, auth.uid(), auth.uid())
  RETURNING * INTO v_tx;

  FOREACH v_no IN ARRAY v_req.container_numbers LOOP
    INSERT INTO public.containers (org_id, transaction_id, container_no, container_type)
    VALUES (v_req.org_id, v_tx.id, v_no, CASE WHEN v_req.container_type IN ('20ft','40ft') THEN v_req.container_type END)
    ON CONFLICT (transaction_id, container_no) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;

  -- documents uploaded against the request now also belong to the transaction (path unchanged)
  UPDATE public.documents d SET transaction_id = v_tx.id
   WHERE d.request_id = v_req.id AND d.transaction_id IS NULL;

  UPDATE public.service_requests r
     SET status = 'converted', client_id = v_client, branch_id = v_branch, reviewed_by = auth.uid(), reviewed_at = now()
   WHERE r.id = v_req.id;

  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
  VALUES (v_req.org_id, v_tx.id, 'request_converted', auth.uid(),
          jsonb_build_object('request_id', v_req.id, 'request_ref', v_req.ref, 'client_id', v_client,
                             'client_created', v_client_created, 'containers', v_n));

  RETURN jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'client_id', v_client,
                            'client_created', v_client_created, 'containers', v_n, 'request_ref', v_req.ref);
END $$;

-- ---------------------------------------------------------------------
-- set_transaction_status — the ONLY way to move operational_status
-- ---------------------------------------------------------------------
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
    WHEN 'new'                    THEN ARRAY['clearance_staff','operations_manager','supervisor','admin']
    WHEN 'in_progress'            THEN ARRAY['clearance_staff','operations_manager','supervisor','admin']
    WHEN 'customs_declaration'    THEN ARRAY['clearance_staff','operations_manager','supervisor','admin']
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
                    ELSE ARRAY['operations_manager','supervisor','admin'] END;
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
      IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, ARRAY['operations_manager','supervisor','admin']) THEN
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
-- set_financial_status — PLACEHOLDER (no ledger/invoicing until G4)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_financial_status(p_transaction_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ev bigint;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF NOT app.is_code('financial_status', p_status) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF p_status = v_tx.financial_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.finance_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF app.code_sort('financial_status', p_status) < app.code_sort('financial_status', v_tx.financial_status) AND v_note IS NULL THEN
    PERFORM app.fail('MRS_NOTE_REQUIRED');
  END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  UPDATE public.transactions t SET financial_status = p_status WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor)
  VALUES (v_tx.org_id, v_tx.id, 'financial_status', v_tx.financial_status, p_status, v_note, false, auth.uid())
  RETURNING id INTO v_ev;
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'from', v_tx.financial_status, 'to', p_status, 'event_id', v_ev);
END $$;

-- ---------------------------------------------------------------------
-- issue_tracking_token — (re)issue a public tracking token for a transaction.
-- Returned once; only its hash is stored. Re-issuing invalidates the old one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_tracking_token(p_transaction_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_token text := app.new_token();
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  UPDATE public.transactions t SET tracking_token_hash = app.hash_token(v_token) WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'tracking_token', auth.uid(), jsonb_build_object('reissued', v_tx.tracking_token_hash IS NOT NULL));
  RETURN jsonb_build_object('ref', v_tx.ref, 'tracking_token', v_token);
END $$;

-- ---------------------------------------------------------------------
-- import_commit — staging rows → service_requests, idempotent per source row.
-- Can be called repeatedly: committed/skipped rows are never touched again,
-- the batch becomes 'committed' only when no row is left open.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_commit(p_batch_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_b public.import_batches;
  v_is_staff boolean;
  r public.import_rows;
  v_new record;
  v_bl text;
  v_dup text;
  v_msg text; v_det text;
  v_items jsonb := '[]'::jsonb;
  v_committed int := 0; v_skipped int := 0; v_dups int := 0; v_errors int := 0; v_open int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_b FROM public.import_batches b WHERE b.id = p_batch_id FOR UPDATE;
  IF v_b.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  -- staff only: bulk rows use source='bulk', which skips the public rate guard and terms check
  v_is_staff := app.has_role(v_b.org_id, app.ops_writer_roles());
  IF NOT v_is_staff THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_b.status <> 'draft' THEN PERFORM app.fail('MRS_BATCH_NOT_DRAFT'); END IF;

  FOR r IN SELECT * FROM public.import_rows x WHERE x.batch_id = v_b.id ORDER BY x.sheet_name, x.row_no FOR UPDATE LOOP
    CONTINUE WHEN r.row_status IN ('committed','skipped');
    IF r.decision = 'skip' THEN
      UPDATE public.import_rows x SET row_status = 'skipped' WHERE x.id = r.id;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF r.row_status = 'error' OR r.normalized IS NULL THEN v_errors := v_errors + 1; CONTINUE; END IF;
    IF r.row_status = 'duplicate' AND r.decision IS DISTINCT FROM 'accept' THEN v_dups := v_dups + 1; CONTINUE; END IF;

    -- natural-key duplicate hint (same B/L already known) → human decision, not silent insert
    IF r.decision IS DISTINCT FROM 'accept' THEN
      v_bl := upper(nullif(btrim(coalesce(r.normalized ->> 'blNumber', '')), ''));
      v_dup := NULL;
      IF v_bl IS NOT NULL THEN
        SELECT s.ref INTO v_dup FROM public.service_requests s
         WHERE s.org_id = v_b.org_id AND s.bl_number = v_bl AND s.status <> 'rejected' LIMIT 1;
        IF v_dup IS NULL THEN
          SELECT t.ref INTO v_dup FROM public.transactions t WHERE t.org_id = v_b.org_id AND t.bl_number = v_bl LIMIT 1;
        END IF;
      END IF;
      IF v_dup IS NOT NULL THEN
        UPDATE public.import_rows x SET row_status = 'duplicate', duplicate_of = v_dup WHERE x.id = r.id;
        v_dups := v_dups + 1; CONTINUE;
      END IF;
    END IF;

    BEGIN
      SELECT * INTO v_new FROM app.insert_service_request(v_b.org_id, r.normalized, 'bulk', v_b.created_by, v_b.client_id, r.id);
      UPDATE public.import_rows x SET row_status = 'committed', validation_errors = '[]'::jsonb WHERE x.id = r.id;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'row_id', r.id, 'sheet', r.sheet_name, 'row_no', r.row_no, 'source_row_id', r.source_row_id,
        'ref', v_new.ref, 'tracking_token', v_new.token));
      v_committed := v_committed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL;
      UPDATE public.import_rows x
         SET row_status = 'error',
             validation_errors = jsonb_build_array(jsonb_build_object(
               'code', CASE WHEN v_msg LIKE 'MRS\_%' THEN v_msg ELSE 'MRS_INVALID' END,
               'field', nullif(v_det, '')))
       WHERE x.id = r.id;
      v_errors := v_errors + 1;
    END;
  END LOOP;

  SELECT count(*) INTO v_open FROM public.import_rows x WHERE x.batch_id = v_b.id AND x.row_status NOT IN ('committed','skipped');
  UPDATE public.import_batches b
     SET committed_rows = (SELECT count(*) FROM public.import_rows x WHERE x.batch_id = v_b.id AND x.row_status = 'committed'),
         skipped_rows   = (SELECT count(*) FROM public.import_rows x WHERE x.batch_id = v_b.id AND x.row_status = 'skipped'),
         total_rows     = (SELECT count(*) FROM public.import_rows x WHERE x.batch_id = v_b.id),
         status         = CASE WHEN v_open = 0 THEN 'committed' ELSE 'draft' END,
         committed_by   = CASE WHEN v_open = 0 THEN auth.uid() ELSE b.committed_by END,
         committed_at   = CASE WHEN v_open = 0 THEN now() ELSE b.committed_at END
   WHERE b.id = v_b.id;

  RETURN jsonb_build_object('batch_id', v_b.id, 'batch_ref', v_b.ref, 'committed', v_committed, 'skipped', v_skipped,
                            'duplicates', v_dups, 'errors', v_errors, 'open_rows', v_open,
                            'batch_status', CASE WHEN v_open = 0 THEN 'committed' ELSE 'draft' END,
                            'items', v_items);
END $$;

-- ---------------------------------------------------------------------
-- privileges: revoke the PUBLIC default, then grant narrowly
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.to_western(text), app.digits(text), app.norm_phone(text, boolean), app.is_email(text), app.new_token(),
  app.hash_token(text), app.ptext(jsonb, text, int, boolean), app.pbool(jsonb, text), app.pnum(jsonb, text, numeric),
  app.insert_service_request(uuid, jsonb, text, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.submit_service_request(jsonb), public.submit_contact_message(jsonb), public.public_track(text, text),
  public.my_context(), public.set_request_status(uuid, text, text),
  public.convert_request_to_transaction(uuid, uuid, uuid), public.set_transaction_status(uuid, text, text),
  public.set_financial_status(uuid, text, text), public.issue_tracking_token(uuid), public.import_commit(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.submit_service_request(jsonb), public.submit_contact_message(jsonb), public.public_track(text, text)
TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.my_context(), public.set_request_status(uuid, text, text),
  public.convert_request_to_transaction(uuid, uuid, uuid), public.set_transaction_status(uuid, text, text),
  public.set_financial_status(uuid, text, text), public.issue_tracking_token(uuid), public.import_commit(uuid)
TO authenticated;

-- ===== migrations/20261031000500_storage.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0500 — private Storage bucket "documents".
--
-- Object name convention (enforced by public.documents.documents_path_chk):
--   {org_id}/{transaction_id}/{document_id}/{file name}
--   {org_id}/r_{request_id}/{document_id}/{file name}       (before conversion)
--
-- Upload flow: 1) INSERT public.documents (id generated client-side, sha256
-- computed in the browser) → 2) upload the bytes to exactly storage_path.
-- Reads: a signed-in user can read an object only if they can SELECT the
-- matching public.documents row (the documents RLS policy decides).
-- No UPDATE / DELETE policies: originals are immutable (new version = new row).
-- =====================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 26214400,
        ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS marsa_documents_read ON storage.objects;
DROP POLICY IF EXISTS marsa_documents_insert ON storage.objects;
DROP POLICY IF EXISTS marsa_documents_no_update ON storage.objects;
DROP POLICY IF EXISTS marsa_documents_no_delete ON storage.objects;

-- read: evaluated as the caller, so public.documents RLS applies inside the EXISTS
CREATE POLICY marsa_documents_read ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'documents'
  AND EXISTS (SELECT 1 FROM public.documents d
              WHERE d.storage_bucket = 'documents' AND d.storage_path = storage.objects.name)
);

-- insert: only into the path of a document row the caller registered (within 24h)
CREATE POLICY marsa_documents_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 3
  AND EXISTS (SELECT 1 FROM public.documents d
              WHERE d.storage_bucket = 'documents'
                AND d.storage_path = storage.objects.name
                AND d.uploaded_by = auth.uid()
                AND d.voided_at IS NULL
                AND d.uploaded_at > now() - interval '24 hours')
);
-- (deliberately no UPDATE / DELETE policy → upsert/overwrite/delete are refused)

-- ===== migrations/20261031000650_admin_rpcs.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0650 — staff-console admin RPCs (admin.html).
--
-- Why RPCs: emails live in auth.users, which the API roles cannot read.
-- An org admin must be able to (a) see member emails of HIS org only and
-- (b) grant a staff role to an EXISTING account by email. No account is
-- ever created here (users sign up themselves; roles are never taken from
-- signup metadata).
--
--   admin_list_members(p_org)                          admin only
--   admin_add_member(p_org, p_email, p_role, p_branch) admin only, staff roles only
--   admin_set_member_active(p_membership, p_active)    admin only; never self,
--                                                      never the last active admin
-- Role changes = add the new membership + deactivate the old one, so the
-- history stays visible (memberships are also covered by the audit trigger).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_list_members(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', m.id, 'user_id', m.user_id, 'email', u.email,
             'full_name', p.full_name, 'phone', p.phone,
             'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
             'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
             'is_active', m.is_active, 'created_at', m.created_at, 'updated_at', m.updated_at,
             'is_me', m.user_id = auth.uid())
           ORDER BY m.is_active DESC, s.sort DESC, u.email)
      FROM public.memberships m
      LEFT JOIN auth.users u        ON u.id = m.user_id
      LEFT JOIN public.profiles p   ON p.id = m.user_id
      LEFT JOIN public.branches b   ON b.id = m.branch_id
      LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
     WHERE m.org_id = p_org), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.admin_add_member(
  p_org uuid, p_email text, p_role text, p_branch uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
  v_m     public.memberships;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF v_email = '' THEN PERFORM app.fail('MRS_REQUIRED', 'email'); END IF;
  IF char_length(v_email) > 160 OR NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  -- staff roles only: portal clients are linked through client_users, not here
  IF p_role IS NULL OR NOT (p_role = ANY (app.staff_roles())) THEN PERFORM app.fail('MRS_INVALID', 'role'); END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.branches b WHERE b.id = p_branch AND b.org_id = p_org AND b.is_active) THEN
    PERFORM app.fail('MRS_INVALID', 'branch');
  END IF;

  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email LIMIT 1;
  IF v_user IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'email'); END IF;

  INSERT INTO public.profiles (id) VALUES (v_user) ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_m FROM public.memberships m
   WHERE m.user_id = v_user AND m.org_id = p_org AND m.role = p_role
     AND m.branch_id IS NOT DISTINCT FROM p_branch
   FOR UPDATE;
  IF v_m.id IS NOT NULL THEN
    IF v_m.is_active THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'membership already exists';
    END IF;
    UPDATE public.memberships m SET is_active = true WHERE m.id = v_m.id RETURNING * INTO v_m;
  ELSE
    INSERT INTO public.memberships (user_id, org_id, branch_id, role, created_by)
    VALUES (v_user, p_org, p_branch, p_role, auth.uid())
    RETURNING * INTO v_m;
  END IF;

  RETURN jsonb_build_object('id', v_m.id, 'user_id', v_m.user_id, 'org_id', v_m.org_id,
                            'branch_id', v_m.branch_id, 'role', v_m.role, 'is_active', v_m.is_active);
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_member_active(p_membership uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_m public.memberships; v_admins int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_m FROM public.memberships m WHERE m.id = p_membership FOR UPDATE;
  IF v_m.id IS NULL OR NOT app.has_role(v_m.org_id, ARRAY['admin']) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
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
  RETURN jsonb_build_object('id', v_m.id, 'is_active', v_m.is_active, 'role', v_m.role);
END $$;

REVOKE EXECUTE ON FUNCTION
  public.admin_list_members(uuid), public.admin_add_member(uuid, text, text, uuid),
  public.admin_set_member_active(uuid, boolean)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.admin_list_members(uuid), public.admin_add_member(uuid, text, text, uuid),
  public.admin_set_member_active(uuid, boolean)
TO authenticated;

-- ===== migrations/20261031000700_security_hardening.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0700 — security review hardening (additive).
--
-- 1. Column-level privacy: RLS limits ROWS, not columns. A client who may
--    read his own transaction / client record must not receive internal
--    staff fields. Those columns are removed from the API roles' SELECT
--    grant; staff read them through public.staff_internal_fields().
--      transactions.notes, transactions.tracking_token_hash,
--      clients.notes, clients.classification,
--      service_requests.tracking_token_hash
--    (UPDATE stays granted, so staff can still write notes; RLS still decides rows.)
--    NOTE: a column added later to these tables is NOT selectable until it is
--    added to the column grant below (fail closed).
-- 2. Sequences: visitors get no USAGE on identity sequences.
-- 3. Default privileges: future tables/sequences in public are not granted to anon.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. column grants
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('transactions',     ARRAY['notes','tracking_token_hash']),
      ('clients',          ARRAY['notes','classification']),
      ('service_requests', ARRAY['tracking_token_hash'])) AS x(tbl, hidden)
  LOOP
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND NOT (c.column_name = ANY (r.hidden));
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', r.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, r.tbl);
  END LOOP;
END $$;

-- staff-only reader for the hidden internal fields (row access = same rules as the table policies)
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
  END IF;
  PERFORM app.fail('MRS_INVALID', 'table');
  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION public.staff_internal_fields(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_internal_fields(text, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------
-- 2./3. sequences + default privileges
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- ===== migrations/20261101000100_document_extractions.sql =====
DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0100 — OCR results (التعرف الضوئي) for
-- invoices and scanned documents: document_extractions.
--
-- The browser runs the OCR (tesseract.js) and decodes the ZATCA e-invoice QR;
-- the database only stores the result. Model:
--   raw_text / extracted_fields / qr_payload = machine output, IMMUTABLE after insert
--   reviewed_fields / line_items / review_*  = what a staff member corrected/approved
-- No DELETE: a wrong row is voided (voided_at + void_reason), like documents.
-- Same bytes saved twice (same org, same transaction or none) = duplicate (23505,
-- index document_extractions_dedupe_uidx).
-- Access: staff of the org only; rows linked to a transaction additionally need a
-- staff role on that transaction's branch. Clients / visitors: no access.
-- Idempotent (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Shape validators (IMMUTABLE → usable in CHECK constraints)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban']
$$;

-- {key: string|null} with known keys only, each value <= 2000 chars
CREATE OR REPLACE FUNCTION app.extraction_fields_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) e
      WHERE NOT (e.key = ANY (app.extraction_field_keys()))
         OR jsonb_typeof(e.value) NOT IN ('string','null')
         OR char_length(e.value #>> '{}') > 2000))
$$;

-- [{description, hs_code, quantity, unit_price, amount}] — max 500 lines, scalar values only
CREATE OR REPLACE FUNCTION app.extraction_items_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_typeof(p) = 'array'
    AND jsonb_array_length(p) <= 500
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) it
      WHERE jsonb_typeof(it) <> 'object'
         OR EXISTS (SELECT 1 FROM jsonb_each(it) e
                    WHERE NOT (e.key = ANY (ARRAY['description','hs_code','quantity','unit_price','amount']))
                       OR jsonb_typeof(e.value) NOT IN ('string','number','null')
                       OR char_length(e.value #>> '{}') > 2000))
$$;

-- ---------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_extractions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  transaction_id    uuid,                                -- optional link (set once: NULL → value)
  document_id       uuid,                                -- original file, when attached to a transaction
  doc_type          text NOT NULL DEFAULT 'other',
  -- source file (the bytes themselves stay in the browser unless attached as a document)
  source_name       text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 255),
  source_sha256     text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_mime       text CHECK (char_length(source_mime) <= 120),
  source_size       bigint CHECK (source_size > 0),
  source_pages      int CHECK (source_pages BETWEEN 1 AND 200),
  -- machine output (immutable)
  engine            text NOT NULL CHECK (char_length(engine) BETWEEN 1 AND 80),      -- e.g. tesseract.js@5.1.1
  languages         text NOT NULL CHECK (char_length(languages) BETWEEN 1 AND 40),   -- e.g. ara+eng
  mean_confidence   numeric CHECK (mean_confidence BETWEEN 0 AND 100),
  raw_text          text NOT NULL CHECK (char_length(raw_text) <= 200000),
  extracted_fields  jsonb NOT NULL DEFAULT '{}'::jsonb,
  qr_payload        jsonb,                               -- decoded ZATCA QR TLV {seller_name, vat_number, timestamp, total, vat_total}
  -- human review
  reviewed_fields   jsonb,
  line_items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status     text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','reviewed','rejected')),
  review_note       text CHECK (char_length(review_note) <= 1000),
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT document_extractions_doc_type_chk CHECK (doc_type = ANY (app.document_kinds())),
  CONSTRAINT document_extractions_fields_chk CHECK (app.extraction_fields_ok(extracted_fields) AND extracted_fields IS NOT NULL),
  CONSTRAINT document_extractions_reviewed_chk CHECK (app.extraction_fields_ok(reviewed_fields)),
  CONSTRAINT document_extractions_items_chk CHECK (app.extraction_items_ok(line_items)),
  CONSTRAINT document_extractions_qr_chk CHECK (
    qr_payload IS NULL OR (jsonb_typeof(qr_payload) = 'object' AND octet_length(qr_payload::text) <= 4000)),
  CONSTRAINT document_extractions_tx_fk  FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT document_extractions_doc_fk FOREIGN KEY (document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT document_extractions_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
-- same file saved twice for the same transaction (or twice unlinked) = duplicate
CREATE UNIQUE INDEX IF NOT EXISTS document_extractions_dedupe_uidx
  ON public.document_extractions (org_id, source_sha256, coalesce(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS document_extractions_org_created_idx ON public.document_extractions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_extractions_tx_idx ON public.document_extractions (transaction_id);
CREATE INDEX IF NOT EXISTS document_extractions_doc_idx ON public.document_extractions (document_id);

-- ---------------------------------------------------------------------
-- 3. Guard trigger: server stamps, immutable machine output, set-once links
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role,
-- and the document lookup below runs under the caller's documents RLS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_document_extractions_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_doc public.documents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.is_api_caller() THEN
      NEW.created_by := auth.uid();
      NEW.created_at := now();
      NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
      NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
    END IF;
    -- saved already reviewed (edited before the first save) → stamp the reviewer
    IF NEW.review_status <> 'unreviewed' THEN
      NEW.reviewed_by := coalesce(auth.uid(), NEW.reviewed_by);
      NEW.reviewed_at := now();
    END IF;
  ELSE
    IF app.is_api_caller() THEN
      IF OLD.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'voided_at'); END IF;
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY[
        'id','org_id','source_name','source_sha256','source_mime','source_size','source_pages',
        'engine','languages','mean_confidence','raw_text','extracted_fields','qr_payload',
        'reviewed_by','reviewed_at','voided_by','created_by','created_at']);
      IF OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
        PERFORM app.fail('MRS_IMMUTABLE', 'transaction_id');
      END IF;
      IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
        PERFORM app.fail('MRS_IMMUTABLE', 'document_id');
      END IF;
    END IF;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status
       OR NEW.reviewed_fields IS DISTINCT FROM OLD.reviewed_fields
       OR NEW.line_items IS DISTINCT FROM OLD.line_items
       OR NEW.review_note IS DISTINCT FROM OLD.review_note
       OR NEW.doc_type IS DISTINCT FROM OLD.doc_type THEN
      NEW.reviewed_by := coalesce(auth.uid(), NEW.reviewed_by);
      NEW.reviewed_at := now();
    END IF;
    IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
      NEW.voided_by := auth.uid();
      NEW.voided_at := now();
    END IF;
  END IF;

  -- the attached original must be a live document of the same transaction
  IF NEW.document_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = NEW.document_id;
    IF v_doc.id IS NULL OR NEW.transaction_id IS NULL
       OR v_doc.transaction_id IS DISTINCT FROM NEW.transaction_id OR v_doc.voided_at IS NOT NULL THEN
      PERFORM app.fail('MRS_INVALID', 'document_id');
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_before ON public.document_extractions;
CREATE TRIGGER trg_before BEFORE INSERT OR UPDATE ON public.document_extractions
  FOR EACH ROW EXECUTE FUNCTION app.tg_document_extractions_before();

-- Audit: same trail as other tables, but WITHOUT the scanned content. audit_select
-- is org-wide for admin/supervisor (no branch check), so copying raw_text / fields
-- (VAT numbers, IBAN) would leak a branch's invoices to other branches and add up to
-- 200 KB per write. changed_fields still names every column that changed.
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
  -- OCR content stays in document_extractions (branch-scoped RLS), never in the trail
  IF TG_TABLE_NAME = 'document_extractions' THEN
    v_old := v_old - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note'];
    v_new := v_new - ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload','review_note'];
  END IF;
  v_org := CASE WHEN TG_TABLE_NAME = 'organizations' THEN (v_row ->> 'id')::uuid
                ELSE nullif(v_row ->> 'org_id', '')::uuid END;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (v_org, TG_TABLE_NAME, v_row ->> 'id', TG_OP, v_changed, v_old, v_new, auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_audit ON public.document_extractions;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.document_extractions
  FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

-- ---------------------------------------------------------------------
-- 4. RLS, policies, grants (no DELETE: void instead)
-- ---------------------------------------------------------------------
ALTER TABLE public.document_extractions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_extractions FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER, DELETE ON public.document_extractions FROM authenticated;

DROP POLICY IF EXISTS document_extractions_select ON public.document_extractions;
DROP POLICY IF EXISTS document_extractions_insert ON public.document_extractions;
DROP POLICY IF EXISTS document_extractions_update ON public.document_extractions;

CREATE POLICY document_extractions_select ON public.document_extractions FOR SELECT TO authenticated
  USING (app.is_staff(org_id)
         AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())));
CREATE POLICY document_extractions_insert ON public.document_extractions FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.is_staff(org_id)
              AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())));
CREATE POLICY document_extractions_update ON public.document_extractions FOR UPDATE TO authenticated
  USING (app.is_staff(org_id)
         AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())))
  WITH CHECK (app.is_staff(org_id)
              AND (transaction_id IS NULL OR app.has_tx_role(transaction_id, app.staff_roles())));

-- CHECK constraints run as the caller → the pure validators must be executable
-- (0300 §7 revokes everything in app; re-granted here because this file runs after it)
REVOKE EXECUTE ON FUNCTION app.extraction_field_keys(), app.extraction_fields_ok(jsonb), app.extraction_items_ok(jsonb),
  app.tg_document_extractions_before() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_field_keys(), app.extraction_fields_ok(jsonb), app.extraction_items_ok(jsonb)
  TO authenticated;

-- ===== migrations/20261102000100_idempotency.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261102000100 — G2.13 request idempotency.
--
-- One row per (scope, key) that SUCCEEDED. A failed RPC rolls back its own
-- row together with everything else it did, so "no row" means "never
-- happened" and a retry with the same key is always safe. A retry of a
-- succeeded call returns the stored response instead of acting twice.
--
--   v := app.idem_begin(scope, key, payload)   -- NULL = go ahead, else = stored response
--   ... do the work ...
--   PERFORM app.idem_finish(scope, key, response);
--
-- Same key + different payload  → MRS_IDEMPOTENCY_CONFLICT (client bug).
-- Concurrent same key: the second INSERT waits on the first transaction's
-- unique-index lock, then sees its committed row and replays it.
-- Keys are client-generated UUIDs, kept by the page across retries until a
-- definite answer arrives (assets/js/supa.js).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  scope        text NOT NULL CHECK (scope ~ '^[a-z_]{2,40}$'),
  key          uuid NOT NULL,
  org_id       uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id      uuid,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON public.idempotency_keys (expires_at);
COMMENT ON TABLE public.idempotency_keys IS 'G2.13: replay store for idempotent RPCs. Written only by SECURITY DEFINER functions.';

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idempotency_keys FROM anon, authenticated;
-- no policies: API roles never read or write this table directly

-- Returns NULL when the caller should do the work, or the stored response
-- of an earlier successful call with the same key and payload.
-- p_key NULL = caller did not ask for idempotency (old clients) → always NULL.
CREATE OR REPLACE FUNCTION app.idem_begin(p_scope text, p_key uuid, p_payload jsonb, p_org uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8')), 'hex');
  v_row  public.idempotency_keys;
BEGIN
  IF p_key IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.idempotency_keys (scope, key, org_id, user_id, request_hash)
  VALUES (p_scope, p_key, p_org, auth.uid(), v_hash)
  ON CONFLICT (scope, key) DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;           -- first time: proceed

  SELECT * INTO v_row FROM public.idempotency_keys k WHERE k.scope = p_scope AND k.key = p_key;
  -- a key belongs to the user (or visitor) who first used it, in the org it was first used for
  -- (the same payload sent to another org must not replay the first org's result)
  IF v_row.user_id IS DISTINCT FROM auth.uid() OR v_row.org_id IS DISTINCT FROM p_org OR v_row.request_hash <> v_hash THEN
    PERFORM app.fail('MRS_IDEMPOTENCY_CONFLICT', 'idempotency_key');
  END IF;
  IF v_row.expires_at < now() THEN
    PERFORM app.fail('MRS_IDEMPOTENCY_CONFLICT', 'expired');
  END IF;
  IF v_row.completed_at IS NULL THEN
    -- unreachable in practice (same transaction re-entering); fail closed
    PERFORM app.fail('MRS_IN_PROGRESS', 'idempotency_key');
  END IF;
  RETURN v_row.response || jsonb_build_object('replayed', true);
END $$;

CREATE OR REPLACE FUNCTION app.idem_finish(p_scope text, p_key uuid, p_response jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_key IS NOT NULL THEN
    UPDATE public.idempotency_keys k
       SET response = p_response, completed_at = now()
     WHERE k.scope = p_scope AND k.key = p_key;
  END IF;
  RETURN p_response;
END $$;

-- payload helper: idempotency key carried inside a jsonb payload ("idempotencyKey")
CREATE OR REPLACE FUNCTION app.idem_key_from(p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := nullif(btrim(coalesce(p_payload ->> 'idempotencyKey', '')), '');
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM app.fail('MRS_INVALID', 'idempotency_key');
  END IF;
  RETURN v::uuid;
END $$;

-- housekeeping (call from a scheduled job; never from the API)
CREATE OR REPLACE FUNCTION app.idem_purge_expired() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM public.idempotency_keys k WHERE k.expires_at < now() - interval '1 day' RETURNING 1)
  SELECT count(*)::int FROM d
$$;

REVOKE EXECUTE ON FUNCTION app.idem_begin(text, uuid, jsonb, uuid), app.idem_finish(text, uuid, jsonb),
  app.idem_key_from(jsonb), app.idem_purge_expired() FROM PUBLIC, anon, authenticated;

-- ===== migrations/20261102000200_orgs_branches_invites.sql =====
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

-- ===== migrations/20261102000300_ops_observability.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261102000300 — G2.9, G2.12–G2.14
-- idempotency rollout, observability, schema versions (docs/online/G2_SPEC.md).
--
-- 1. public.schema_versions: one row per migration file (backfilled here for
--    every file up to and including this one). Read only via health_check().
-- 2. health_check()            anon + authenticated → {ok, db_time, schema_version, environment}
--                              (nothing tenant-specific).
-- 3. public.client_errors + log_client_error(p_payload) anon + authenticated.
--    Fields truncated, e-mails / phone numbers / long digit runs / JWTs /
--    tokens scrubbed BEFORE storage, rate limited (20 per user-or-visitor,
--    300 for all visitors together, 500 global per 10 minutes → silently
--    {logged:false}; the visitor key is the edge-set / right-most forwarded IP). Bad input never
--    raises, except an oversized payload (MRS_TOO_LONG).
--    Readers: admin_recent_errors(p_org) (org admin), platform_recent_errors()
--    (platform admin).
-- 4. admin_audit_log(p_org, p_filters) — paginated audit reader with actor
--    e-mail; org admin + supervisor (same as the audit_select policy).
-- 5. Idempotency (app.idem_* from 20261102000100) on submit_service_request,
--    submit_contact_message (payload.idempotencyKey), convert_request_to_transaction,
--    set_transaction_status, set_financial_status, issue_tracking_token
--    (new optional LAST parameter p_idem_key uuid DEFAULT NULL; the old
--    signatures are dropped first so PostgREST sees one function per name).
--    Bodies are copied from their latest definition (set_transaction_status
--    from 20261102000200, with branch_manager); only the idempotency lines are
--    new. Tracking tokens are NEVER stored in idempotency_keys.response: a
--    replay returns tracking_token / token NULL and token_shown:true.
--
-- NOTE: re-running 20261102000200 on its own AFTER this file re-creates the
-- 3-argument set_transaction_status next to the 4-argument one (ambiguous
-- calls). Always re-run the migrations in order (0200 then 0300).
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. schema versions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_versions (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{14}$'),
  name       text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,80}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.schema_versions IS 'G2.14: one row per applied migration file (supabase/migrations/<version>_<name>.sql). Read via health_check().';
ALTER TABLE public.schema_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.schema_versions FROM anon, authenticated;
-- no policies: API roles read the max version through health_check() only

-- backfill: every migration file so far (each later migration adds its own row)
INSERT INTO public.schema_versions (version, name) VALUES
  ('20261031000100', 'core_tenancy'),
  ('20261031000200', 'operations'),
  ('20261031000300', 'security_rls'),
  ('20261031000400', 'rpc'),
  ('20261031000500', 'storage'),
  ('20261031000650', 'admin_rpcs'),
  ('20261031000700', 'security_hardening'),
  ('20261101000100', 'document_extractions'),
  ('20261102000100', 'idempotency'),
  ('20261102000200', 'orgs_branches_invites'),
  ('20261102000300', 'ops_observability')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. health check (deliberately anon: no auth.uid() check, no tenant data)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.health_check() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('ok', true, 'db_time', now(),
                            'schema_version', (SELECT max(v.version) FROM public.schema_versions v),
                            'environment', 'staging')
$$;

-- ---------------------------------------------------------------------
-- 3. client error log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_errors (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES public.organizations(id) ON DELETE CASCADE,  -- only when the caller is a member
  user_id    uuid,                                                          -- NULL for visitors
  actor_key  text NOT NULL CHECK (actor_key ~ '^[0-9a-f]{64}$'),           -- sha256 of user / visitor (rate limit; no raw IP)
  page       text CHECK (char_length(page) <= 200),
  code       text CHECK (char_length(code) <= 60),
  message    text CHECK (char_length(message) <= 500),
  ua         text CHECK (char_length(ua) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.client_errors IS 'G2.12: scrubbed front-end errors (window.onerror). Written only by log_client_error(); read via admin_recent_errors / platform_recent_errors.';
CREATE INDEX IF NOT EXISTS client_errors_actor_idx ON public.client_errors (actor_key, created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_created_idx ON public.client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_org_idx ON public.client_errors (org_id, created_at DESC);
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_errors FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.client_errors_id_seq FROM anon, authenticated;
-- no policies: API roles never read or write this table directly

-- Removes personal data / secrets from free text, then truncates.
-- Order matters: JWTs and tokens before e-mails, hex before digit runs.
CREATE OR REPLACE FUNCTION app.scrub_text(p text, p_max int) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := left(app.to_western(coalesce(p, '')), 4000);   -- bound the regex work
BEGIN
  v := regexp_replace(v, '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g');
  v := regexp_replace(v, 'eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]*)?', '[jwt]', 'g');
  v := regexp_replace(v, '(bearer|apikey|authorization)([[:space:]]*[:=]?[[:space:]]*)[A-Za-z0-9._~+/=-]{8,}', '\1\2[secret]', 'gi');
  v := regexp_replace(v, '(token|invite|access_token|refresh_token|apikey|key|password|secret|code)=[^&[:space:]#"'']+', '\1=[redacted]', 'gi');
  v := regexp_replace(v, '\m(sb_secret_|sb_publishable_|sk_|pk_)[A-Za-z0-9_-]{8,}', '[secret]', 'g');
  v := regexp_replace(v, '%40', '@', 'gi');                     -- percent-encoded e-mails
  v := regexp_replace(v, '[^[:space:]@<>()"'',;:]+@[^[:space:]@<>()"'',;:]+\.[A-Za-z]{2,}', '[email]', 'g');
  v := regexp_replace(v, '[0-9A-Fa-f]{32,}', '[hex]', 'g');
  v := regexp_replace(v, '[A-Za-z0-9_-]{40,}', '[token]', 'g');
  -- Saudi IBAN (SA + 22, optionally grouped) before the '00…' phone rule (which would eat its check digits)
  v := regexp_replace(v, '\mSA[0-9]{2}([ ]?[0-9A-Za-z]){20}\M', '[iban]', 'gi');
  -- phone numbers: international / Saudi forms with separators, then any long digit run
  v := regexp_replace(v, '(\+|00)[0-9][0-9 ().-]{6,}[0-9]', '[number]', 'g');
  v := regexp_replace(v, '\m0?5[0-9]([ .-]?[0-9]){7}\M', '[number]', 'g');
  -- 8+ digits split by spaces / dashes (cards, landlines, spaced IDs). '.' is not a
  -- separator here (versions / IPs stay readable); ISO dates are masked too — accepted.
  v := regexp_replace(v, '[0-9]([ -]?[0-9]){7,}', '[number]', 'g');
  v := regexp_replace(v, '[0-9]{6,}', '[number]', 'g');
  v := nullif(btrim(v), '');
  RETURN left(v, p_max);
END $$;

CREATE OR REPLACE FUNCTION public.log_client_error(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_who   text;
  v_actor text;
  v_page  text;
  v_code  text;
  v_msg   text;
  v_ua    text;
  v_h     jsonb;
  v_xff   text[];
BEGIN
  -- deliberately callable by visitors: no auth check. Only an oversized payload raises.
  IF p_payload IS NOT NULL AND length(p_payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RETURN jsonb_build_object('logged', false); END IF;

  -- who: signed-in user, else the visitor's IP, else the page's random visitor id (hashed, never stored raw).
  -- The IP comes from what the edge sets (cf-connecting-ip / x-real-ip) or the RIGHT-most
  -- X-Forwarded-For hop (appended by the proxy). The left-most hop is client-controlled
  -- and would let one visitor rotate past the per-visitor limit.
  IF v_uid IS NOT NULL THEN
    v_who := 'u:' || v_uid::text;
  ELSE
    BEGIN
      v_h := current_setting('request.headers', true)::jsonb;
      v_xff := string_to_array(v_h ->> 'x-forwarded-for', ',');
      v_who := coalesce(nullif(btrim(v_h ->> 'cf-connecting-ip'), ''), nullif(btrim(v_h ->> 'x-real-ip'), ''),
                        nullif(btrim(v_xff[array_length(v_xff, 1)]), ''));
      IF v_who !~ '^[0-9A-Fa-f:.]{3,45}$' THEN v_who := NULL; END IF;
    EXCEPTION WHEN others THEN v_who := NULL;
    END;
    v_who := coalesce('ip:' || v_who,
                      'v:' || CASE WHEN (p_payload ->> 'visitorId') ~* '^[0-9a-f-]{36}$' THEN lower(p_payload ->> 'visitorId') END,
                      'anon');
  END IF;
  v_actor := app.hash_token(v_who);

  -- rate limits: drop silently (the page must not retry or learn anything).
  -- Visitors share a smaller budget (300) so they can never starve signed-in errors.
  IF (SELECT count(*) FROM public.client_errors e
       WHERE e.actor_key = v_actor AND e.created_at > now() - interval '10 minutes') >= 20
     OR (SELECT count(*) FROM public.client_errors e WHERE e.created_at > now() - interval '10 minutes') >= 500
     OR (v_uid IS NULL AND (SELECT count(*) FROM public.client_errors e
                             WHERE e.user_id IS NULL AND e.created_at > now() - interval '10 minutes') >= 300) THEN
    RETURN jsonb_build_object('logged', false);
  END IF;

  -- org only when the caller is an active member (visitors cannot attribute errors to a tenant)
  IF v_uid IS NOT NULL AND (p_payload ->> 'orgId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND app.is_member((p_payload ->> 'orgId')::uuid) THEN
    v_org := (p_payload ->> 'orgId')::uuid;
  END IF;

  -- page: path only (query string / fragment may carry tokens)
  v_page := app.scrub_text(split_part(split_part(CASE WHEN jsonb_typeof(p_payload -> 'page') = 'string' THEN p_payload ->> 'page' END,
                                                 '?', 1), '#', 1), 200);
  v_code := left(nullif(regexp_replace(CASE WHEN jsonb_typeof(p_payload -> 'code') IN ('string','number') THEN p_payload ->> 'code' END,
                                       '[^A-Za-z0-9_.:-]', '', 'g'), ''), 60);
  v_msg  := app.scrub_text(CASE WHEN jsonb_typeof(p_payload -> 'message') = 'string' THEN p_payload ->> 'message' END, 500);
  v_ua   := app.scrub_text(CASE WHEN jsonb_typeof(p_payload -> 'ua') = 'string' THEN p_payload ->> 'ua' END, 200);
  IF v_msg IS NULL AND v_code IS NULL THEN RETURN jsonb_build_object('logged', false); END IF;

  INSERT INTO public.client_errors (org_id, user_id, actor_key, page, code, message, ua)
  VALUES (v_org, v_uid, v_actor, v_page, v_code, v_msg, v_ua);
  RETURN jsonb_build_object('logged', true);
END $$;

-- housekeeping (call from a scheduled job; never from the API)
CREATE OR REPLACE FUNCTION app.client_errors_purge(p_days int DEFAULT 30) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM public.client_errors e WHERE e.created_at < now() - make_interval(days => greatest(p_days, 1)) RETURNING 1)
  SELECT count(*)::int FROM d
$$;

-- Daily housekeeping when pg_cron is enabled (Supabase: Database → Extensions → pg_cron).
-- Without pg_cron (local PGlite, tests) nothing happens; docs/online/ENVIRONMENTS_AR.md
-- lists the manual fallback. cron.schedule(name, …) replaces a job of the same name.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.schedule('marsa_idem_purge', '17 3 * * *', 'SELECT app.idem_purge_expired()')$q$;
    EXECUTE $q$SELECT cron.schedule('marsa_client_errors_purge', '27 3 * * *', 'SELECT app.client_errors_purge(30)')$q$;
  END IF;
END $cron$;

-- latest 200 errors of one org (org admin only)
CREATE OR REPLACE FUNCTION public.admin_recent_errors(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', x.id, 'created_at', x.created_at, 'page', x.page, 'code', x.code, 'message', x.message,
             'ua', x.ua, 'user_id', x.user_id, 'user_email', u.email) ORDER BY x.id DESC)
      FROM (SELECT * FROM public.client_errors e WHERE e.org_id = p_org ORDER BY e.id DESC LIMIT 200) x
      LEFT JOIN auth.users u ON u.id = x.user_id), '[]'::jsonb);
END $$;

-- latest 200 errors platform-wide (platform admin only). No user identity:
-- the platform operator manages organizations, not tenant users.
CREATE OR REPLACE FUNCTION public.platform_recent_errors() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.is_platform_admin() THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', x.id, 'created_at', x.created_at, 'org_id', x.org_id, 'org_slug', o.slug,
             'page', x.page, 'code', x.code, 'message', x.message, 'ua', x.ua,
             'signed_in', x.user_id IS NOT NULL) ORDER BY x.id DESC)
      FROM (SELECT * FROM public.client_errors e ORDER BY e.id DESC LIMIT 200) x
      LEFT JOIN public.organizations o ON o.id = x.org_id), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------
-- 4. audit log reader
--    p_filters: {table_name?, actor? (uuid), from?, to? (timestamptz), row_id?,
--                limit? (1..200, default 50), before_id? (keyset pagination)}
--    → {items:[…], next_before_id (NULL on the last page)}
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS audit_log_org_id_idx ON public.audit_log (org_id, id DESC);

CREATE OR REPLACE FUNCTION public.admin_audit_log(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_table text;
  v_actor uuid;
  v_from  timestamptz;
  v_to    timestamptz;
  v_row   text;
  v_limit int := 50;
  v_before bigint;
  v_items jsonb;
  v_n     int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  -- same readers as the audit_select policy; branch_manager is not one of them
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','supervisor']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  PERFORM app.only_keys(f, ARRAY['table_name','actor','from','to','row_id','limit','before_id']);

  v_table := app.ptext(f, 'table_name', 63);
  IF v_table !~ '^[a-z_]{1,63}$' THEN PERFORM app.fail('MRS_INVALID', 'table_name'); END IF;
  v_actor := app.puuid(f, 'actor');
  v_row := app.ptext(f, 'row_id', 100);
  BEGIN
    v_from := nullif(btrim(coalesce(f ->> 'from', '')), '')::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', 'from');
  END;
  BEGIN
    v_to := nullif(btrim(coalesce(f ->> 'to', '')), '')::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', 'to');
  END;
  IF f ? 'limit' AND f ->> 'limit' IS NOT NULL THEN
    IF (f ->> 'limit') !~ '^[0-9]{1,6}$' THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
    v_limit := least(greatest((f ->> 'limit')::int, 1), 200);
  END IF;
  IF f ? 'before_id' AND f ->> 'before_id' IS NOT NULL THEN
    IF (f ->> 'before_id') !~ '^[0-9]{1,18}$' THEN PERFORM app.fail('MRS_INVALID', 'before_id'); END IF;
    v_before := (f ->> 'before_id')::bigint;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'at', x.at, 'table_name', x.table_name, 'row_id', x.row_id, 'action', x.action,
           'changed_fields', to_jsonb(x.changed_fields), 'old_data', x.old_data, 'new_data', x.new_data,
           'actor', x.actor, 'actor_email', u.email, 'actor_role', x.actor_role) ORDER BY x.id DESC), '[]'::jsonb),
         count(*)
    INTO v_items, v_n
    FROM (SELECT a.* FROM public.audit_log a
           WHERE a.org_id = p_org
             AND (v_table IS NULL OR a.table_name = v_table)
             AND (v_actor IS NULL OR a.actor = v_actor)
             AND (v_row IS NULL OR a.row_id = v_row)
             AND (v_from IS NULL OR a.at >= v_from)
             AND (v_to IS NULL OR a.at < v_to)
             AND (v_before IS NULL OR a.id < v_before)
           ORDER BY a.id DESC
           LIMIT v_limit) x
    LEFT JOIN auth.users u ON u.id = x.actor;

  RETURN jsonb_build_object('items', v_items,
    'next_before_id', CASE WHEN v_n = v_limit THEN (SELECT min((i ->> 'id')::bigint) FROM jsonb_array_elements(v_items) i) END);
END $$;

-- ---------------------------------------------------------------------
-- 5. idempotency rollout
-- ---------------------------------------------------------------------
-- submit_service_request (signature unchanged; key in payload.idempotencyKey)
CREATE OR REPLACE FUNCTION public.submit_service_request(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
  v_uid uuid := auth.uid();
  v_client uuid;
  v_res record;
  v_key uuid;
  v_replay jsonb;
  v_out jsonb;
BEGIN
  -- replay BEFORE the open/active gate: a committed submission whose response was lost
  -- still replays after intake is closed (unknown slug → the same MRS_INTAKE_CLOSED)
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea');
  IF v_org.id IS NULL THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  v_key := app.idem_key_from(payload);
  v_replay := app.idem_begin('submit_service_request', v_key, payload, v_org.id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT v_org.is_active OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;

  -- a signed-in client may attach the request to one of their own client records
  IF v_uid IS NOT NULL AND (payload ->> 'clientId') ~ '^[0-9a-f-]{36}$' THEN
    SELECT c.id INTO v_client FROM public.clients c
     WHERE c.id = (payload ->> 'clientId')::uuid AND c.org_id = v_org.id AND app.is_client_user(c.id);
  END IF;

  SELECT * INTO v_res FROM app.insert_service_request(
    v_org.id, payload, CASE WHEN v_uid IS NULL THEN 'web' ELSE 'portal' END, v_uid, v_client, NULL);

  -- the stored replay copy never holds the tracking token
  v_out := jsonb_build_object('ref', v_res.ref, 'tracking_token', NULL, 'token', NULL, 'token_shown', true,
                              'status', 'new', 'created_at', now(), 'environment', v_org.environment);
  PERFORM app.idem_finish('submit_service_request', v_key, v_out);
  RETURN (v_out - 'token') || jsonb_build_object('tracking_token', v_res.token, 'token_shown', false);
END $$;

-- submit_contact_message (signature unchanged; key in payload.idempotencyKey).
-- The replay check runs before the intake gate and the rate guards, so a retry is
-- never rate limited and still replays after intake was closed.
CREATE OR REPLACE FUNCTION public.submit_contact_message(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
  v_phone text;
  v_email text;
  v_subject text;
  v_pref text;
  v_ref text;
  v_key uuid;
  v_replay jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  IF length(payload::text) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'payload'); END IF;
  SELECT * INTO v_org FROM public.organizations o
   WHERE o.slug = coalesce(nullif(payload ->> 'orgSlug', ''), 'blue-sea');
  IF v_org.id IS NULL THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;
  v_key := app.idem_key_from(payload);
  v_replay := app.idem_begin('submit_contact_message', v_key, payload, v_org.id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT v_org.is_active OR NOT v_org.public_intake_enabled THEN PERFORM app.fail('MRS_INTAKE_CLOSED'); END IF;

  IF char_length(app.ptext(payload, 'name', 120, true)) < 3 THEN PERFORM app.fail('MRS_INVALID', 'name'); END IF;
  v_phone := app.norm_phone(app.ptext(payload, 'phone', 25, true), true);
  IF v_phone IS NULL THEN PERFORM app.fail('MRS_INVALID', 'phone'); END IF;
  v_email := lower(app.ptext(payload, 'email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  v_subject := app.ptext(payload, 'subject', 20, true);
  IF v_subject NOT IN ('quote','aci','saber','hs','duties','tracking','export','partnership','complaint','other') THEN
    PERFORM app.fail('MRS_INVALID', 'subject');
  END IF;
  IF char_length(app.ptext(payload, 'message', 1000, true)) < 15 THEN PERFORM app.fail('MRS_INVALID', 'message'); END IF;
  v_pref := coalesce(app.ptext(payload, 'preferred', 20), 'phone');
  IF v_pref NOT IN ('phone','whatsapp','email') THEN PERFORM app.fail('MRS_INVALID', 'preferred'); END IF;
  IF NOT app.pbool(payload, 'consent') THEN PERFORM app.fail('MRS_REQUIRED', 'consent'); END IF;

  IF (SELECT count(*) FROM public.contact_messages m
       WHERE m.org_id = v_org.id AND m.phone = v_phone AND m.created_at > now() - interval '1 hour') >= 5 THEN
    PERFORM app.fail('MRS_RATE_LIMITED', 'phone');
  END IF;
  IF (SELECT count(*) FROM public.contact_messages m
       WHERE m.org_id = v_org.id AND m.created_at > now() - interval '10 minutes') >= 120 THEN
    PERFORM app.fail('MRS_RATE_LIMITED', 'org');
  END IF;

  v_ref := app.next_ref(v_org.id, 'message');
  INSERT INTO public.contact_messages (org_id, ref, name, company, phone, email, subject, reference, message, preferred, submitted_by)
  VALUES (v_org.id, v_ref, app.ptext(payload, 'name', 120), app.ptext(payload, 'company', 160), v_phone, v_email,
          v_subject, app.ptext(payload, 'reference', 40), app.ptext(payload, 'message', 1000), v_pref, auth.uid());
  RETURN app.idem_finish('submit_contact_message', v_key, jsonb_build_object('ref', v_ref, 'created_at', now()));
END $$;

-- convert_request_to_transaction (+ p_idem_key). The replay check runs after the
-- row lock and the access check, so a concurrent retry waits and then replays.
DROP FUNCTION IF EXISTS public.convert_request_to_transaction(uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.convert_request_to_transaction(
  p_request_id uuid, p_branch_id uuid DEFAULT NULL, p_client_id uuid DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req public.service_requests;
  v_branch uuid;
  v_client uuid;
  v_client_created boolean := false;
  v_tx public.transactions;
  v_no text;
  v_n int := 0;
  v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_req FROM public.service_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL OR NOT app.has_request_role(v_req.id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('convert_request', p_idem_key,
    jsonb_build_object('request_id', p_request_id, 'branch_id', p_branch_id, 'client_id', p_client_id), v_req.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_req.status = 'converted' OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.request_id = v_req.id) THEN
    PERFORM app.fail('MRS_ALREADY_CONVERTED');
  END IF;
  IF v_req.status = 'rejected' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'rejected'); END IF;

  v_branch := coalesce(p_branch_id, v_req.branch_id);
  IF v_branch IS NULL THEN PERFORM app.fail('MRS_BRANCH_REQUIRED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = v_req.org_id AND b.is_active)
     OR NOT app.has_branch_role(v_req.org_id, v_branch, app.ops_writer_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'branch');
  END IF;

  -- client master: explicit → request link → natural key (CR / VAT) → new record
  IF p_client_id IS NOT NULL THEN
    SELECT c.id INTO v_client FROM public.clients c WHERE c.id = p_client_id AND c.org_id = v_req.org_id;
    IF v_client IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  ELSIF v_req.client_id IS NOT NULL THEN
    v_client := v_req.client_id;
  ELSE
    SELECT c.id INTO v_client FROM public.clients c
     WHERE c.org_id = v_req.org_id
       AND ((v_req.cr_number IS NOT NULL AND c.cr_number = v_req.cr_number)
         OR (v_req.vat_number IS NOT NULL AND c.vat_number = v_req.vat_number))
     ORDER BY (c.cr_number = v_req.cr_number) DESC NULLS LAST LIMIT 1;
    IF v_client IS NULL THEN
      INSERT INTO public.clients (org_id, client_type, name_ar, contact_person, cr_number, vat_number, phone, email,
                                  preferred_contact, created_by, notes)
      VALUES (v_req.org_id, coalesce(v_req.client_type, 'business'),
              CASE WHEN v_req.client_type = 'individual' OR v_req.company IS NULL OR v_req.company = 'فرد'
                   THEN v_req.full_name ELSE v_req.company END,
              v_req.full_name, v_req.cr_number, v_req.vat_number, v_req.phone,
              CASE WHEN app.is_email(v_req.email) THEN v_req.email END,
              v_req.contact_pref, auth.uid(), 'أُنشئ من طلب الخدمة ' || v_req.ref)
      RETURNING id INTO v_client;
      v_client_created := true;
    END IF;
  END IF;

  INSERT INTO public.transactions (
    org_id, branch_id, client_id, request_id, operation, mode, service,
    port_of_loading, port_of_discharge, country, goods_description, hs_code, shipping_line, bl_number,
    declaration_no, container_count, package_count, eta, responsible_user_id, created_by)
  VALUES (
    v_req.org_id, v_branch, v_client, v_req.id, v_req.direction, v_req.mode, v_req.service,
    CASE WHEN v_req.direction = 'export' THEN v_req.port END,
    CASE WHEN v_req.direction = 'import' THEN v_req.port END,
    v_req.country, v_req.goods, v_req.hs_code, v_req.shipping_line, v_req.bl_number,
    v_req.declaration_no,
    greatest(coalesce(array_length(v_req.container_numbers, 1), 0),
             CASE WHEN v_req.count_kind = 'containers' THEN coalesce(v_req.declared_count, 0) ELSE 0 END),
    CASE WHEN v_req.count_kind = 'packages' THEN v_req.declared_count END,
    v_req.eta, auth.uid(), auth.uid())
  RETURNING * INTO v_tx;

  FOREACH v_no IN ARRAY v_req.container_numbers LOOP
    INSERT INTO public.containers (org_id, transaction_id, container_no, container_type)
    VALUES (v_req.org_id, v_tx.id, v_no, CASE WHEN v_req.container_type IN ('20ft','40ft') THEN v_req.container_type END)
    ON CONFLICT (transaction_id, container_no) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;

  -- documents uploaded against the request now also belong to the transaction (path unchanged)
  UPDATE public.documents d SET transaction_id = v_tx.id
   WHERE d.request_id = v_req.id AND d.transaction_id IS NULL;

  UPDATE public.service_requests r
     SET status = 'converted', client_id = v_client, branch_id = v_branch, reviewed_by = auth.uid(), reviewed_at = now()
   WHERE r.id = v_req.id;

  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
  VALUES (v_req.org_id, v_tx.id, 'request_converted', auth.uid(),
          jsonb_build_object('request_id', v_req.id, 'request_ref', v_req.ref, 'client_id', v_client,
                             'client_created', v_client_created, 'containers', v_n));

  RETURN app.idem_finish('convert_request', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'client_id', v_client,
                       'client_created', v_client_created, 'containers', v_n, 'request_ref', v_req.ref));
END $$;

-- set_transaction_status (+ p_idem_key; body = 20261102000200, branch_manager kept)
DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text);
CREATE OR REPLACE FUNCTION public.set_transaction_status(
  p_transaction_id uuid, p_status text, p_note text DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
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
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('set_transaction_status', p_idem_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'status', p_status, 'note', p_note), v_tx.org_id);
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
  RETURN app.idem_finish('set_transaction_status', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'from', v_tx.operational_status,
                       'to', p_status, 'event_id', v_ev));
END $$;

-- set_financial_status (+ p_idem_key) — PLACEHOLDER (no ledger/invoicing until G4)
DROP FUNCTION IF EXISTS public.set_financial_status(uuid, text, text);
CREATE OR REPLACE FUNCTION public.set_financial_status(
  p_transaction_id uuid, p_status text, p_note text DEFAULT NULL, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ev bigint; v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  v_replay := app.idem_begin('set_financial_status', p_idem_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'status', p_status, 'note', p_note), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT app.is_code('financial_status', p_status) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF p_status = v_tx.financial_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.finance_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF app.code_sort('financial_status', p_status) < app.code_sort('financial_status', v_tx.financial_status) AND v_note IS NULL THEN
    PERFORM app.fail('MRS_NOTE_REQUIRED');
  END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  UPDATE public.transactions t SET financial_status = p_status WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, note, visible_to_client, actor)
  VALUES (v_tx.org_id, v_tx.id, 'financial_status', v_tx.financial_status, p_status, v_note, false, auth.uid())
  RETURNING id INTO v_ev;
  RETURN app.idem_finish('set_financial_status', p_idem_key,
    jsonb_build_object('transaction_id', v_tx.id, 'from', v_tx.financial_status, 'to', p_status, 'event_id', v_ev));
END $$;

-- issue_tracking_token (+ p_idem_key). The token is returned once and never
-- stored (only its hash on the transaction); a replay says it was already shown.
DROP FUNCTION IF EXISTS public.issue_tracking_token(uuid);
CREATE OR REPLACE FUNCTION public.issue_tracking_token(p_transaction_id uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_token text := app.new_token(); v_replay jsonb; v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('issue_tracking_token', p_idem_key, jsonb_build_object('transaction_id', p_transaction_id), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  UPDATE public.transactions t SET tracking_token_hash = app.hash_token(v_token) WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'tracking_token', auth.uid(), jsonb_build_object('reissued', v_tx.tracking_token_hash IS NOT NULL));
  v_out := jsonb_build_object('ref', v_tx.ref, 'tracking_token', NULL, 'token', NULL, 'token_shown', true);
  PERFORM app.idem_finish('issue_tracking_token', p_idem_key, v_out);
  RETURN (v_out - 'token') || jsonb_build_object('tracking_token', v_token, 'token_shown', false);
END $$;

-- ---------------------------------------------------------------------
-- 6. privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.scrub_text(text, int), app.client_errors_purge(int) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.health_check(), public.log_client_error(jsonb), public.admin_recent_errors(uuid),
  public.platform_recent_errors(), public.admin_audit_log(uuid, jsonb),
  public.submit_service_request(jsonb), public.submit_contact_message(jsonb),
  public.convert_request_to_transaction(uuid, uuid, uuid, uuid), public.set_transaction_status(uuid, text, text, uuid),
  public.set_financial_status(uuid, text, text, uuid), public.issue_tracking_token(uuid, uuid)
FROM PUBLIC, anon, authenticated;

-- deliberately public (visitors): intake forms, health check, error beacon
GRANT EXECUTE ON FUNCTION
  public.health_check(), public.log_client_error(jsonb),
  public.submit_service_request(jsonb), public.submit_contact_message(jsonb)
TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.admin_recent_errors(uuid), public.platform_recent_errors(), public.admin_audit_log(uuid, jsonb),
  public.convert_request_to_transaction(uuid, uuid, uuid, uuid), public.set_transaction_status(uuid, text, text, uuid),
  public.set_financial_status(uuid, text, text, uuid), public.issue_tracking_token(uuid, uuid)
TO authenticated;

-- Re-run safety: G3 (20261103000200) replaces set_transaction_status(uuid, text, text, uuid) with a
-- 5-argument version (+ p_docs_override boolean DEFAULT false). If this file is re-run on its own after
-- G3, drop the 4-argument overload it just recreated (ambiguous calls, and it lacks the document gate).
DO $reruns$
BEGIN
  IF to_regprocedure('public.set_transaction_status(uuid, text, text, uuid, boolean)') IS NOT NULL THEN
    DROP FUNCTION IF EXISTS public.set_transaction_status(uuid, text, text, uuid);
  END IF;
END $reruns$;

-- ===== migrations/20261103000100_g3_registry.sql =====
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

-- ===== migrations/20261103000200_g3_operations.sql =====
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

-- ===== migrations/20261104000100_g4_costs.sql =====
-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261104000100 — G4: suppliers & operating costs
-- (docs/online/G4_SPEC.md). Builds on G3 (20261103000100 + 20261103000200).
--
-- Controls costs, client charges and their sources WITHOUT a second ledger:
-- no journal, no GL accounts, no tax invoices (Daftra / G5).
--   1.  parties: finance columns (iban_last4, bank_name, payment_terms_days,
--       default_currency) guarded by app.tg_parties_fin_guard + save_party_finance;
--       address / contact_name written like the other party fields.
--   2.  finance_documents + private bucket "finance" (supplier originals, evidence).
--   3.  supplier_invoices (number_norm hard uniqueness, soft duplicate detection,
--       state machine, approval gate, four eyes).
--   4.  supplier_invoice_lines (never dropped, auto review reasons, sum check).
--   5.  cost_allocations (Σ never above the line net, share rounding, approval,
--       late costs → cost_adjustments, reverse).
--   6.  cost_accruals (one per trip / demurrage case / approved fee; in place while
--       unmatched, variance after a match; matching + review). Backfill: one per
--       existing non-cancelled trip.
--   7.  supplier_payments (evidence; append-only; payment cache on the invoice).
--   8.  client_charges (sell side, price independent of cost unless sourced).
--   9.  charge_collections (collected-from-client evidence, capped by the charge).
--   10. demurrage_cases (storage / demurrage / detention; four separate figures).
--   11. cost_adjustments (exceptional fees, duplicates, amendments).
--   12. app.fin_cost_items + tx_margin / margin_report / cost_report.
--   13. readers for the UI.
-- Clients see nothing from G4 (no SELECT policy, no RPC result). Finance events
-- (transaction_events 'finance') are internal and never carry amounts.
-- Errors: new MRS_OVER_ALLOCATED / MRS_OVERPAID; duplicates MRS_INVALID '<x>_taken' /
-- 'file_duplicate' with the existing row id in the error HINT (DETAIL stays the code).
-- Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS); preflight first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261103000200') THEN
    RAISE EXCEPTION 'G4 preflight: apply G3 first (schema_versions lacks 20261103000200 g3_operations)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transport_trips t WHERE t.status <> 'cancelled' AND t.cost_currency !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'G4 preflight: transport_trips has a non-cancelled trip with an invalid cost_currency (fix it before the accrual backfill)';
  END IF;
  -- supervisors read finance figures through audit_log org-wide (audit_select / admin_audit_log use app.has_role),
  -- so G4 requires them to be org-wide: a branch-scoped supervisor would bypass the per-branch finance scope.
  IF EXISTS (SELECT 1 FROM public.memberships m WHERE m.role = 'supervisor' AND m.branch_id IS NOT NULL AND m.is_active) THEN
    RAISE EXCEPTION 'G4 preflight: active branch-scoped supervisor membership(s) found — make them org-wide (UPDATE public.memberships SET branch_id = NULL WHERE role = ''supervisor'' AND branch_id IS NOT NULL) or give them another role, then re-run';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261104000100', 'g4_costs')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('fin_invoice_status','received',1,'مستلمة','Received',false),
  ('fin_invoice_status','under_review',2,'قيد المراجعة','Under review',false),
  ('fin_invoice_status','approved',3,'معتمدة','Approved',false),
  ('fin_invoice_status','disputed',4,'معترض عليها','Disputed',false),
  ('fin_invoice_status','void',5,'ملغاة','Void',false),
  ('fin_invoice_doc_type','invoice',1,'فاتورة','Invoice',false),
  ('fin_invoice_doc_type','credit_note',2,'إشعار دائن','Credit note',false),
  ('fin_invoice_doc_type','debit_note',3,'إشعار مدين','Debit note',false),
  ('fin_payment_status','unpaid',1,'غير مدفوعة','Unpaid',false),
  ('fin_payment_status','partial',2,'مدفوعة جزئيًا','Partially paid',false),
  ('fin_payment_status','paid',3,'مدفوعة','Paid',false),
  ('fin_payment_status','paid_directly_by_client',4,'دفعها العميل مباشرة','Paid directly by client',false),
  ('fin_line_review','pending_review',1,'بانتظار المراجعة','Pending review',false),
  ('fin_line_review','ok',2,'سليم','OK',false),
  ('fin_line_review','overhead',3,'مصروف عام','Overhead',false),
  ('fin_line_review','excluded',4,'مستبعد','Excluded',false),
  ('fin_line_review','disputed',5,'معترض عليه','Disputed',false),
  ('fin_alloc_status','proposed',1,'مقترح','Proposed',false),
  ('fin_alloc_status','approved',2,'معتمد','Approved',false),
  ('fin_alloc_status','rejected',3,'مرفوض','Rejected',false),
  ('fin_alloc_status','reversed',4,'معكوس','Reversed',false),
  ('fin_accrual_status','open',1,'مفتوح','Open',false),
  ('fin_accrual_status','matched',2,'مطابق','Matched',false),
  ('fin_accrual_status','variance',3,'فرق بانتظار المراجعة','Variance',false),
  ('fin_accrual_status','void',4,'ملغى','Void',false),
  ('fin_accrual_source','trip',1,'رحلة نقل','Transport trip',false),
  ('fin_accrual_source','demurrage',2,'أرضيات / غرامات','Storage / demurrage',false),
  ('fin_accrual_source','adjustment',3,'تسوية / رسوم استثنائية','Adjustment / fee',false),
  ('fin_accrual_source','manual',4,'يدوي','Manual',false),
  ('fin_variance_reason','amount_diff',1,'فرق في المبلغ','Amount difference',false),
  ('fin_variance_reason','trip_cost_changed_after_match',2,'تغيّرت تكلفة الرحلة بعد المطابقة','Trip cost changed after match',false),
  ('fin_variance_reason','trip_cancelled_after_match',3,'أُلغيت الرحلة بعد المطابقة','Trip cancelled after match',false),
  ('fin_variance_reason','allocation_reversed',4,'عُكس تخصيص مطابق','Allocation reversed',false),
  ('fin_charge_kind','service',1,'خدمة','Service',false),
  ('fin_charge_kind','internal_service',2,'خدمة داخلية','Internal service',false),
  ('fin_charge_kind','reimbursable',3,'مصروف مسترد (نيابة عن العميل)','Reimbursable disbursement',false),
  ('fin_charge_status','draft',1,'مسودة','Draft',false),
  ('fin_charge_status','approved',2,'معتمد','Approved',false),
  ('fin_charge_status','invoiced',3,'مفوتر','Invoiced',false),
  ('fin_charge_status','void',4,'ملغى','Void',false),
  ('fin_charge_source','manual',1,'يدوي','Manual',false),
  ('fin_charge_source','from_cost',2,'بسعر التكلفة','At cost',false),
  ('fin_charge_source','markup',3,'تكلفة + نسبة','Cost + markup',false),
  ('fin_charge_source','from_trip',4,'من سعر الرحلة','From trip price',false),
  ('fin_payment_method','bank_transfer',1,'تحويل بنكي','Bank transfer',false),
  ('fin_payment_method','cash',2,'نقدًا','Cash',false),
  ('fin_payment_method','cheque',3,'شيك','Cheque',false),
  ('fin_payment_method','card',4,'بطاقة','Card',false),
  ('fin_payment_method','offset',5,'مقاصة','Offset',false),
  ('fin_payment_method','other',6,'أخرى','Other',false),
  ('fin_payer','company',1,'الشركة','Company',false),
  ('fin_payer','client',2,'العميل مباشرة','Client directly',false),
  ('fin_demurrage_kind','storage',1,'أرضيات','Storage',false),
  ('fin_demurrage_kind','demurrage',2,'غرامة تأخير (ديمرج)','Demurrage',false),
  ('fin_demurrage_kind','detention',3,'غرامة احتجاز الحاوية','Detention',false),
  ('fin_demurrage_status','open',1,'مفتوحة','Open',false),
  ('fin_demurrage_status','closed',2,'مغلقة','Closed',false),
  ('fin_demurrage_status','waived',3,'تم التنازل','Waived',false),
  ('fin_demurrage_status','void',4,'ملغاة','Void',false),
  ('fin_adjustment_kind','late_cost',1,'تكلفة متأخرة','Late cost',false),
  ('fin_adjustment_kind','empty_fee',2,'رسوم الحاوية الفارغة','Empty container fee',false),
  ('fin_adjustment_kind','washing',3,'غسيل','Washing',false),
  ('fin_adjustment_kind','repair',4,'إصلاح','Repair',false),
  ('fin_adjustment_kind','amendment',5,'تعديل فاتورة','Amendment',false),
  ('fin_adjustment_kind','duplicate_invoice',6,'فاتورة مكررة','Duplicate invoice',false),
  ('fin_adjustment_kind','other',7,'أخرى','Other',false),
  ('fin_adjustment_status','proposed',1,'مقترحة','Proposed',false),
  ('fin_adjustment_status','approved',2,'معتمدة','Approved',false),
  ('fin_adjustment_status','rejected',3,'مرفوضة','Rejected',false),
  ('fin_level','confirmed',1,'مؤكد','Confirmed',false),
  ('fin_level','estimated',2,'تقديري','Estimated',false),
  ('fin_level','unknown',3,'غير معروف','Unknown',false),
  ('fin_doc_kind','supplier_invoice',1,'فاتورة مورد','Supplier invoice',false),
  ('fin_doc_kind','credit_note',2,'إشعار دائن','Credit note',false),
  ('fin_doc_kind','payment_evidence',3,'إثبات سداد','Payment evidence',false),
  ('fin_doc_kind','collection_evidence',4,'إثبات تحصيل','Collection evidence',false),
  ('fin_doc_kind','adjustment_evidence',5,'مستند تسوية','Adjustment evidence',false),
  ('fin_doc_kind','demurrage_evidence',6,'مستند أرضيات / غرامة','Demurrage evidence',false),
  ('fin_doc_kind','other',7,'أخرى','Other',false),
  ('fin_service','customs_clearance',1,'تخليص جمركي','Customs clearance',false),
  ('fin_service','transport',2,'نقل','Transport',false),
  ('fin_service','port_charges',3,'رسوم ميناء','Port charges',false),
  ('fin_service','delivery_order',4,'إذن تسليم','Delivery order',false),
  ('fin_service','storage',5,'أرضيات','Storage',false),
  ('fin_service','demurrage',6,'غرامة تأخير','Demurrage',false),
  ('fin_service','detention',7,'غرامة احتجاز','Detention',false),
  ('fin_service','inspection',8,'معاينة / كشف','Inspection',false),
  ('fin_service','empty_handling',9,'مناولة الفارغ','Empty handling',false),
  ('fin_service','washing',10,'غسيل','Washing',false),
  ('fin_service','repair',11,'إصلاح','Repair',false),
  ('fin_service','documentation',12,'مستندات','Documentation',false),
  ('fin_service','saber',13,'سابر','SABER',false),
  ('fin_service','other',14,'أخرى','Other',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- finance events (internal, never amounts): superset of the G3 list
ALTER TABLE public.transaction_events DROP CONSTRAINT IF EXISTS transaction_events_event_type_check;
ALTER TABLE public.transaction_events ADD CONSTRAINT transaction_events_event_type_check CHECK (event_type IN
  ('created','request_converted','operational_status','financial_status','container_return','document','note','tracking_token',
   -- G3 (A): declarations, B/L links, container operational state
   'declaration','bl','container',
   -- G3 (B): appointments, transport trips, operational exceptions, document-requirement overrides
   'appointment','trip','exception','docs_override',
   -- G4: finance (internal; payload {op, entity, id, …ids}, never amounts)
   'finance'));

-- supervisor (like admin) is org-wide by construction: audit_log shows them every G4 row of the org, amounts included.
-- NOT VALID first (an inactive / pending legacy row never blocks the apply), validated when the data is clean.
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_supervisor_no_branch;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_supervisor_no_branch
  CHECK (role <> 'supervisor' OR branch_id IS NULL) NOT VALID;
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_supervisor_no_branch;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_supervisor_no_branch
  CHECK (role <> 'supervisor' OR branch_id IS NULL) NOT VALID;
DO $sup$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.role = 'supervisor' AND m.branch_id IS NOT NULL) THEN
    ALTER TABLE public.memberships VALIDATE CONSTRAINT memberships_supervisor_no_branch;
  ELSE
    RAISE NOTICE 'G4: inactive branch-scoped supervisor memberships kept; memberships_supervisor_no_branch stays NOT VALID (enforced for new rows)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invitations i WHERE i.role = 'supervisor' AND i.branch_id IS NOT NULL) THEN
    ALTER TABLE public.invitations VALIDATE CONSTRAINT invitations_supervisor_no_branch;
  ELSE
    RAISE NOTICE 'G4: branch-scoped supervisor invitation(s) found; they can no longer be accepted (invitations_supervisor_no_branch NOT VALID)';
  END IF;
END $sup$;

-- composite FK targets: children of a transaction point at ITS trip / exception
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transport_trips_id_tx_uniq' AND conrelid = 'public.transport_trips'::regclass) THEN
    ALTER TABLE public.transport_trips ADD CONSTRAINT transport_trips_id_tx_uniq UNIQUE (id, transaction_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operational_exceptions_id_tx_uniq' AND conrelid = 'public.operational_exceptions'::regclass) THEN
    ALTER TABLE public.operational_exceptions ADD CONSTRAINT operational_exceptions_id_tx_uniq UNIQUE (id, transaction_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- roles + small helpers
-- ---------------------------------------------------------------------
-- may see costs, supplier prices, payments, charges, margins, demurrage figures
CREATE OR REPLACE FUNCTION app.fin_read_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accountant','accounts_manager','branch_manager','supervisor','admin']
$$;
-- create invoices / lines / allocations / payments / charges / cases / adjustments
CREATE OR REPLACE FUNCTION app.fin_write_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accountant','accounts_manager','branch_manager','admin']
$$;
-- approve invoices, allocations, charges, adjustments, variances; void payments
CREATE OR REPLACE FUNCTION app.fin_approve_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accounts_manager','branch_manager','admin']
$$;

-- error with a machine-readable HINT (existing row id, line numbers …); DETAIL stays the code word
CREATE OR REPLACE FUNCTION app.fin_fail(p_code text, p_detail text, p_hint text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = coalesce(p_detail, ''), HINT = coalesce(p_hint, '');
END $$;

-- service catalog code (nullable)
CREATE OR REPLACE FUNCTION app.fin_check_service(p_code text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_code IS NOT NULL AND NOT app.is_code('fin_service', p_code) THEN PERFORM app.fail('MRS_INVALID', 'service_code'); END IF;
END $$;

-- money from a payload: >= 0, 2 decimals (sign always comes from the document type)
CREATE OR REPLACE FUNCTION app.fin_money(p jsonb, k text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v numeric;
BEGIN
  IF jsonb_typeof(p -> k) IN ('object','array','boolean') THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  v := app.pnum(p, k, 999999999999.99);
  IF v IS NOT NULL AND v <> round(v, 2) THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  RETURN v;
END $$;

-- currency code from a payload (NULL when absent)
CREATE OR REPLACE FUNCTION app.fin_currency(p jsonb, k text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE s text := upper(app.ptext(p, k, 3));
BEGIN
  IF s IS NOT NULL AND s !~ '^[A-Z]{3}$' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  RETURN s;
END $$;

-- mandatory reason / note (trimmed, ≤ p_max)
CREATE OR REPLACE FUNCTION app.fin_note(p text, p_field text, p_max int DEFAULT 2000) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := nullif(btrim(coalesce(p, '')), '');
BEGIN
  IF v IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', p_field); END IF;
  IF char_length(v) > p_max THEN PERFORM app.fail('MRS_TOO_LONG', p_field); END IF;
  RETURN v;
END $$;

-- invoice number normalization: Arabic-Indic digits → western, upper case, leading zeros of every
-- digit run stripped, Arabic spelling variants folded (أ/إ/آ → ا, ة → ه, ى → ي; tatweel and harakat dropped),
-- every run of other characters becomes one separator, and the separator is kept ONLY between two digits
-- (so 'A-1-23' ≠ 'A-12-3' and '2026/1/05' → '2026-1-5', while 'inv-0012' / 'INV 12' → 'INV12').
-- 'inv-0012' → 'INV12', 'INV 12' → 'INV12', '١٢٣' → '123', 'فاتورة 12' = 'فاتوره 12' → 'فاتوره12'
CREATE OR REPLACE FUNCTION app.fin_norm_no(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT replace(replace(
           regexp_replace(
             btrim(regexp_replace(
               translate(regexp_replace(upper(app.to_western(coalesce(p, ''))), '(^|[^0-9])0+([0-9])', '\1\2', 'g'),
                         'أإآٱةى' || chr(1600) || chr(1611) || chr(1612) || chr(1613) || chr(1614) || chr(1615) || chr(1616) || chr(1617) || chr(1618),
                         'ااااهي'),
               '[^A-Z0-9ءؤئابتثجحخدذرزسشصضطظعغفقكلمنهوي]+', '-', 'g'), '-'),
             '([0-9])-(?=[0-9])', '\1#', 'g'),
           '-', ''), '#', '-')
$$;

-- one internal finance event (never amounts): payload {op, entity, id} || ids
CREATE OR REPLACE FUNCTION app.fin_event(p_org uuid, p_tx uuid, p_op text, p_entity text, p_id uuid,
  p_from text DEFAULT NULL, p_to text DEFAULT NULL, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_tx IS NULL THEN RETURN; END IF;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (p_org, p_tx, 'finance', p_from, p_to, false, auth.uid(),
          jsonb_build_object('op', p_op, 'entity', p_entity, 'id', p_id) || coalesce(p_extra, '{}'::jsonb));
END $$;

-- transaction visible to the caller as staff (else MRS_NOT_FOUND) and readable for finance (else MRS_FORBIDDEN 'finance')
CREATE OR REPLACE FUNCTION app.fin_tx_read(p_tx uuid) RETURNS public.transactions
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.transactions;
BEGIN
  SELECT * INTO v FROM public.transactions t WHERE t.id = p_tx;
  IF v.id IS NULL OR NOT app.has_tx_role(v.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_branch_role(v.org_id, v.branch_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'finance'); END IF;
  RETURN v;
END $$;

-- org-level finance read (reports, lists): MRS_FORBIDDEN 'finance' without a finance read role anywhere in the org
CREATE OR REPLACE FUNCTION app.fin_org_read(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.fin_read_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'finance'); END IF;
END $$;

-- four eyes: the approver is not the creator (admin excepted)
CREATE OR REPLACE FUNCTION app.fin_four_eyes(p_org uuid, p_creator uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_creator IS NOT DISTINCT FROM auth.uid() AND NOT app.has_role(p_org, ARRAY['admin']) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'self_approval');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. parties: official / finance data (plan step ١; kinds / CR / VAT / phone / e-mail exist since G3)
-- ---------------------------------------------------------------------
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS iban_last4 text CHECK (iban_last4 ~ '^[0-9]{4}$');   -- never the full IBAN
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS bank_name text CHECK (char_length(bank_name) <= 80);
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS payment_terms_days int CHECK (payment_terms_days BETWEEN 0 AND 365);
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS default_currency char(3) NOT NULL DEFAULT 'SAR' CHECK (default_currency ~ '^[A-Z]{3}$');
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS address text CHECK (char_length(address) <= 300);
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS contact_name text CHECK (char_length(contact_name) <= 120);

-- finance columns change only through save_party_finance (transaction-local flag marsa.fin_party = on)
CREATE OR REPLACE FUNCTION app.tg_parties_fin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(current_setting('marsa.fin_party', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.iban_last4 IS NOT NULL OR NEW.bank_name IS NOT NULL OR NEW.payment_terms_days IS NOT NULL
       OR NEW.default_currency IS DISTINCT FROM 'SAR' THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'party_finance');
    END IF;
  ELSIF (NEW.iban_last4, NEW.bank_name, NEW.payment_terms_days, NEW.default_currency)
        IS DISTINCT FROM (OLD.iban_last4, OLD.bank_name, OLD.payment_terms_days, OLD.default_currency) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'party_finance');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fin_guard ON public.parties;
CREATE TRIGGER trg_fin_guard BEFORE INSERT OR UPDATE ON public.parties FOR EACH ROW EXECUTE FUNCTION app.tg_parties_fin_guard();

-- save_party_finance(p_party, {iban_last4?, bank_name?, payment_terms_days?, default_currency?}) — partial
CREATE OR REPLACE FUNCTION public.save_party_finance(p_party uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_p public.parties; s text; n numeric;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_p FROM public.parties p WHERE p.id = p_party FOR UPDATE;
  IF v_p.id IS NULL OR NOT app.is_staff(v_p.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'party'); END IF;
  IF NOT app.has_role(v_p.org_id, app.fin_write_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['iban_last4','bank_name','payment_terms_days','default_currency']);
  IF p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  IF p_payload ? 'iban_last4' THEN
    s := app.to_western(app.ptext(p_payload, 'iban_last4', 4));
    IF s IS NOT NULL AND s !~ '^[0-9]{4}$' THEN PERFORM app.fail('MRS_INVALID', 'iban_last4'); END IF;
    v_p.iban_last4 := s;
  END IF;
  IF p_payload ? 'bank_name' THEN v_p.bank_name := app.ptext(p_payload, 'bank_name', 80); END IF;
  IF p_payload ? 'payment_terms_days' THEN
    n := app.pnum(p_payload, 'payment_terms_days', 365);
    IF n IS NOT NULL AND n <> trunc(n) THEN PERFORM app.fail('MRS_INVALID', 'payment_terms_days'); END IF;
    v_p.payment_terms_days := n::int;
  END IF;
  IF p_payload ? 'default_currency' THEN v_p.default_currency := coalesce(app.fin_currency(p_payload, 'default_currency'), 'SAR'); END IF;
  PERFORM set_config('marsa.fin_party', 'on', true);
  UPDATE public.parties p SET iban_last4 = v_p.iban_last4, bank_name = v_p.bank_name,
         payment_terms_days = v_p.payment_terms_days, default_currency = v_p.default_currency
   WHERE p.id = v_p.id RETURNING * INTO v_p;
  PERFORM set_config('marsa.fin_party', 'off', true);
  RETURN to_jsonb(v_p);
END $$;

-- ---------------------------------------------------------------------
-- 2. finance_documents: originals outside the transaction documents (steps ٤, ٧, ١١)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fin_mime_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic',
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv']
$$;

CREATE TABLE IF NOT EXISTS public.finance_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id      uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('supplier_invoice','credit_note','payment_evidence','collection_evidence',
                   'adjustment_evidence','demurrage_evidence','other')),
  storage_bucket text NOT NULL DEFAULT 'finance' CHECK (storage_bucket = 'finance'),
  storage_path   text NOT NULL UNIQUE CHECK (char_length(storage_path) <= 512),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_name  text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  mime_type      text CHECK (char_length(mime_type) <= 120),
  size_bytes     bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  uploaded_by    uuid NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz,
  voided_by      uuid,
  void_reason    text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT finance_documents_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  -- {org_id}/{id}/{file name}: three segments, no '..'
  CONSTRAINT finance_documents_path_chk CHECK (
    split_part(storage_path, '/', 1) = org_id::text
    AND split_part(storage_path, '/', 2) = id::text
    AND split_part(storage_path, '/', 3) <> ''
    AND split_part(storage_path, '/', 4) = ''
    AND storage_path NOT LIKE '%..%'),
  CONSTRAINT finance_documents_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.finance_documents IS 'G4 finance originals (supplier invoices, payment / collection evidence…) in the private "finance" bucket. Never client-visible; voided, never deleted.';
CREATE UNIQUE INDEX IF NOT EXISTS finance_documents_sha_uidx ON public.finance_documents (org_id, sha256) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_documents_branch_idx ON public.finance_documents (org_id, branch_id, uploaded_at DESC);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('finance', 'finance', false, 26214400, app.fin_mime_types())
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS marsa_finance_read ON storage.objects;
DROP POLICY IF EXISTS marsa_finance_insert ON storage.objects;
-- read: evaluated as the caller, so finance_documents RLS (finance read roles of the branch) applies
CREATE POLICY marsa_finance_read ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'finance'
  AND EXISTS (SELECT 1 FROM public.finance_documents d
              WHERE d.storage_bucket = 'finance' AND d.storage_path = storage.objects.name)
);
-- insert: only into the path of a non-voided row the caller registered within 24 h
CREATE POLICY marsa_finance_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'finance'
  AND array_length(storage.foldername(name), 1) = 2
  AND EXISTS (SELECT 1 FROM public.finance_documents d
              WHERE d.storage_bucket = 'finance'
                AND d.storage_path = storage.objects.name
                AND d.uploaded_by = auth.uid()
                AND d.voided_at IS NULL
                AND d.uploaded_at > now() - interval '24 hours')
);
-- (deliberately no UPDATE / DELETE policy: originals are immutable)

-- register_finance_document({branch_id, kind, original_name, mime_type?, size_bytes, sha256}, p_idem_key)
-- → {id, storage_bucket, storage_path}; the page then uploads the bytes to exactly that path.
CREATE OR REPLACE FUNCTION public.register_finance_document(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_br public.branches; v_brid uuid; v_replay jsonb; v_kind text; v_name text; v_mime text; v_size numeric; v_sha text;
  v_dup uuid; v_id uuid := gen_random_uuid(); v_path text; v_d public.finance_documents;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['branch_id','kind','original_name','mime_type','size_bytes','sha256','idempotencyKey']);
  v_brid := app.puuid(p_payload, 'branch_id');
  IF v_brid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'branch_id'); END IF;
  SELECT * INTO v_br FROM public.branches b WHERE b.id = v_brid;
  IF v_br.id IS NULL OR NOT app.is_staff(v_br.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'branch'); END IF;
  IF NOT app.has_branch_role(v_br.org_id, v_br.id, app.fin_write_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('register_finance_document', p_idem_key, p_payload - 'idempotencyKey', v_br.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_kind := coalesce(app.ptext(p_payload, 'kind', 40), 'supplier_invoice');
  IF NOT app.is_code('fin_doc_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_name := app.ptext(p_payload, 'original_name', 255, true);
  v_mime := lower(app.ptext(p_payload, 'mime_type', 120));
  IF v_mime IS NOT NULL AND NOT (v_mime = ANY (app.fin_mime_types())) THEN PERFORM app.fail('MRS_INVALID', 'mime_type'); END IF;
  v_size := app.pnum(p_payload, 'size_bytes', 26214400);
  IF v_size IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'size_bytes'); END IF;
  IF v_size < 1 OR v_size <> trunc(v_size) THEN PERFORM app.fail('MRS_INVALID', 'size_bytes'); END IF;
  v_sha := lower(app.ptext(p_payload, 'sha256', 64, true));
  IF v_sha !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', 'sha256'); END IF;
  SELECT * INTO v_d FROM public.finance_documents d WHERE d.org_id = v_br.org_id AND d.sha256 = v_sha AND d.voided_at IS NULL;
  IF v_d.id IS NOT NULL THEN
    -- the caller's own registration of the same file that never got attached (a create that failed, a closed dialog):
    -- handed back instead of blocking that file forever
    IF v_d.uploaded_by = auth.uid() AND v_d.branch_id = v_br.id AND v_d.kind = v_kind
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoices si WHERE si.finance_document_id = v_d.id)
       AND NOT EXISTS (SELECT 1 FROM public.supplier_payments sp WHERE sp.evidence_document_id = v_d.id)
       AND NOT EXISTS (SELECT 1 FROM public.charge_collections k WHERE k.evidence_document_id = v_d.id)
       AND NOT EXISTS (SELECT 1 FROM public.cost_adjustments j WHERE j.finance_document_id = v_d.id) THEN
      RETURN app.idem_finish('register_finance_document', p_idem_key,
        jsonb_build_object('id', v_d.id, 'storage_bucket', v_d.storage_bucket, 'storage_path', v_d.storage_path,
                           'branch_id', v_d.branch_id, 'kind', v_d.kind, 'sha256', v_d.sha256, 'original_name', v_d.original_name,
                           'reused', true));
    END IF;
    v_dup := v_d.id;
    PERFORM app.fin_fail('MRS_INVALID', 'file_duplicate', v_dup::text);
  END IF;
  -- one safe file-name segment (no separators, no '..')
  v_path := v_br.org_id::text || '/' || v_id::text || '/'
            || left(coalesce(nullif(regexp_replace(replace(v_name, '..', '_'), '[/\\[:cntrl:]]', '_', 'g'), ''), 'file'), 200);
  INSERT INTO public.finance_documents (id, org_id, branch_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by)
  VALUES (v_id, v_br.org_id, v_br.id, v_kind, v_path, v_sha, v_name, v_mime, v_size::bigint, auth.uid())
  RETURNING * INTO v_d;
  RETURN app.idem_finish('register_finance_document', p_idem_key,
    jsonb_build_object('id', v_d.id, 'storage_bucket', v_d.storage_bucket, 'storage_path', v_d.storage_path,
                       'branch_id', v_d.branch_id, 'kind', v_d.kind, 'sha256', v_d.sha256, 'original_name', v_d.original_name));
END $$;

-- void_finance_document(p_id, p_reason) — refused while it is the original of a non-void invoice
CREATE OR REPLACE FUNCTION public.void_finance_document(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_d public.finance_documents; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_d FROM public.finance_documents d WHERE d.id = p_id FOR UPDATE;
  IF v_d.id IS NULL OR NOT app.has_branch_role(v_d.org_id, v_d.branch_id, app.fin_read_roles()) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'finance_document');
  END IF;
  IF NOT app.has_branch_role(v_d.org_id, v_d.branch_id, app.fin_approve_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_reason := app.fin_note(p_reason, 'reason', 500);
  IF v_d.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'voided'); END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_invoices si WHERE si.finance_document_id = v_d.id AND si.status <> 'void') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'in_use');
  END IF;
  UPDATE public.finance_documents d SET voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   WHERE d.id = v_d.id RETURNING * INTO v_d;
  RETURN to_jsonb(v_d);
END $$;

-- ---------------------------------------------------------------------
-- 3.–11. tables (functions follow)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL,                     -- receiving branch: scope, immutable
  supplier_id          uuid NOT NULL,
  doc_type             text NOT NULL DEFAULT 'invoice' CHECK (doc_type IN ('invoice','credit_note','debit_note')),
  adjusts_invoice_id   uuid,
  invoice_number       text NOT NULL CHECK (char_length(invoice_number) BETWEEN 1 AND 60),
  number_norm          text NOT NULL CHECK (char_length(number_norm) BETWEEN 1 AND 60),
  invoice_date         date NOT NULL,
  due_date             date,
  received_at          timestamptz NOT NULL DEFAULT now(),
  currency             char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal             numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  vat_amount           numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  total_amount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  reference            text CHECK (char_length(reference) <= 120),
  supplier_vat_number  text CHECK (supplier_vat_number ~ '^[0-9]{15}$'),
  finance_document_id  uuid,
  source_document_id   uuid,
  status               text NOT NULL DEFAULT 'received' CHECK (status IN ('received','under_review','approved','disputed','void')),
  status_note          text CHECK (char_length(status_note) <= 2000),
  approved_by          uuid,
  approved_at          timestamptz,
  discrepancy_note     text CHECK (char_length(discrepancy_note) <= 2000),
  company_paid_amount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (company_paid_amount >= 0),
  client_paid_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (client_paid_amount >= 0),
  payment_status       text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid','paid_directly_by_client')),
  void_reason          text CHECK (char_length(void_reason) <= 2000),
  duplicate_of_id      uuid,
  notes                text CHECK (char_length(notes) <= 2000),
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoices_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT supplier_invoices_supplier_fk FOREIGN KEY (supplier_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT supplier_invoices_findoc_fk FOREIGN KEY (finance_document_id, org_id) REFERENCES public.finance_documents(id, org_id),
  CONSTRAINT supplier_invoices_srcdoc_fk FOREIGN KEY (source_document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT supplier_invoices_total_chk CHECK (total_amount = subtotal + vat_amount),
  CONSTRAINT supplier_invoices_due_chk CHECK (due_date IS NULL OR due_date >= invoice_date),
  CONSTRAINT supplier_invoices_adjusts_chk CHECK ((doc_type = 'invoice') = (adjusts_invoice_id IS NULL) AND adjusts_invoice_id IS DISTINCT FROM id),
  CONSTRAINT supplier_invoices_void_chk CHECK (status <> 'void' OR void_reason IS NOT NULL),
  CONSTRAINT supplier_invoices_dup_chk CHECK (duplicate_of_id IS DISTINCT FROM id),
  UNIQUE (id, org_id)
);
ALTER TABLE public.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_adjusts_fk;
ALTER TABLE public.supplier_invoices ADD CONSTRAINT supplier_invoices_adjusts_fk
  FOREIGN KEY (adjusts_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id);
ALTER TABLE public.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_duplicate_fk;
ALTER TABLE public.supplier_invoices ADD CONSTRAINT supplier_invoices_duplicate_fk
  FOREIGN KEY (duplicate_of_id, org_id) REFERENCES public.supplier_invoices(id, org_id);
COMMENT ON TABLE public.supplier_invoices IS 'G4 supplier invoices / credit & debit notes (received, never a tax invoice). Payment cache is derived from supplier_payments only: an invoice never proves a payment.';
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_number_uidx ON public.supplier_invoices (org_id, supplier_id, doc_type, number_norm) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS supplier_invoices_inbox_idx ON public.supplier_invoices (org_id, branch_id, status, invoice_date DESC);
CREATE INDEX IF NOT EXISTS supplier_invoices_supplier_idx ON public.supplier_invoices (org_id, supplier_id, invoice_date);

CREATE TABLE IF NOT EXISTS public.supplier_invoice_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  supplier_invoice_id uuid NOT NULL,
  line_no             int NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  description         text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  quantity            numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit                text CHECK (char_length(unit) <= 20),
  unit_price          numeric(14,2) CHECK (unit_price >= 0),
  net_amount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  vat_rate            numeric(5,2) NOT NULL DEFAULT 15 CHECK (vat_rate BETWEEN 0 AND 100),
  vat_amount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  total_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  service_code        text,
  container_no_hint   text CHECK (char_length(container_no_hint) <= 20),
  reference_hint      text CHECK (char_length(reference_hint) <= 120),
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ocr','import')),
  review_status       text NOT NULL DEFAULT 'pending_review' CHECK (review_status IN ('pending_review','ok','overhead','excluded','disputed')),
  review_reasons      text[] NOT NULL DEFAULT '{}',
  review_note         text CHECK (char_length(review_note) <= 2000),
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_lines_invoice_fk FOREIGN KEY (supplier_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id),
  CONSTRAINT supplier_invoice_lines_total_chk CHECK (total_amount = net_amount + vat_amount),
  CONSTRAINT supplier_invoice_lines_no_uniq UNIQUE (supplier_invoice_id, line_no),
  CONSTRAINT supplier_invoice_lines_note_chk CHECK (review_status NOT IN ('overhead','excluded','disputed') OR review_note IS NOT NULL),
  UNIQUE (id, org_id),
  UNIQUE (id, supplier_invoice_id)
);
COMMENT ON TABLE public.supplier_invoice_lines IS 'G4 every line of a supplier invoice, kept as on paper (never deleted; a wrong line becomes excluded with a note).';

CREATE TABLE IF NOT EXISTS public.demurrage_cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  transaction_id     uuid NOT NULL,
  container_id       uuid,                                 -- NULL for LCL
  kind               text NOT NULL CHECK (kind IN ('storage','demurrage','detention')),
  operator_id        uuid,
  exception_id       uuid,
  free_until         date,
  charged_until      date,
  days               int CHECK (days BETWEEN 0 AND 3650),
  estimated_amount   numeric(14,2) CHECK (estimated_amount >= 0),   -- net, the expected operator amount
  estimated_vat_rate numeric(5,2) NOT NULL DEFAULT 15 CHECK (estimated_vat_rate BETWEEN 0 AND 100),
  currency           char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','waived','void')),
  status_note        text CHECK (char_length(status_note) <= 2000),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demurrage_cases_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT demurrage_cases_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT demurrage_cases_operator_fk FOREIGN KEY (operator_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT demurrage_cases_exception_fk FOREIGN KEY (exception_id, transaction_id) REFERENCES public.operational_exceptions(id, transaction_id),
  CONSTRAINT demurrage_cases_dates_chk CHECK (charged_until IS NULL OR free_until IS NULL OR charged_until >= free_until),
  CONSTRAINT demurrage_cases_note_chk CHECK (status NOT IN ('waived','void') OR status_note IS NOT NULL),
  UNIQUE (id, org_id),
  UNIQUE (id, transaction_id)
);
COMMENT ON TABLE public.demurrage_cases IS 'G4 storage / demurrage / detention tracker (أرضيات وغرامات). Four figures (charged, collected, paid to operator, remaining) each from its own records.';
CREATE INDEX IF NOT EXISTS demurrage_cases_tx_idx ON public.demurrage_cases (transaction_id);
CREATE INDEX IF NOT EXISTS demurrage_cases_open_idx ON public.demurrage_cases (org_id, status);

CREATE TABLE IF NOT EXISTS public.cost_adjustments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('late_cost','empty_fee','washing','repair','amendment','duplicate_invoice','other')),
  transaction_id      uuid,
  container_id        uuid,
  supplier_invoice_id uuid,
  related_invoice_id  uuid,
  exception_id        uuid,
  supplier_id         uuid,
  service_code        text,
  amount              numeric(14,2) CHECK (amount >= 0),
  currency            char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  finance_document_id uuid,
  document_id         uuid,
  reason              text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  review_note         text CHECK (char_length(review_note) <= 2000),
  accrual_id          uuid,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_adjustments_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT cost_adjustments_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT cost_adjustments_invoice_fk FOREIGN KEY (supplier_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id),
  CONSTRAINT cost_adjustments_related_fk FOREIGN KEY (related_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id),
  CONSTRAINT cost_adjustments_exception_fk FOREIGN KEY (exception_id, transaction_id) REFERENCES public.operational_exceptions(id, transaction_id),
  CONSTRAINT cost_adjustments_supplier_fk FOREIGN KEY (supplier_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT cost_adjustments_findoc_fk FOREIGN KEY (finance_document_id, org_id) REFERENCES public.finance_documents(id, org_id),
  CONSTRAINT cost_adjustments_doc_fk FOREIGN KEY (document_id, org_id) REFERENCES public.documents(id, org_id),
  -- always linked to a document (an invoice carries its original) and to a transaction or an invoice
  CONSTRAINT cost_adjustments_doc_chk CHECK (finance_document_id IS NOT NULL OR document_id IS NOT NULL OR supplier_invoice_id IS NOT NULL),
  CONSTRAINT cost_adjustments_target_chk CHECK (transaction_id IS NOT NULL OR supplier_invoice_id IS NOT NULL),
  CONSTRAINT cost_adjustments_invoice_kind_chk CHECK (kind NOT IN ('duplicate_invoice','amendment') OR supplier_invoice_id IS NOT NULL),
  CONSTRAINT cost_adjustments_related_chk CHECK (kind <> 'duplicate_invoice'
                                                 OR (related_invoice_id IS NOT NULL AND related_invoice_id IS DISTINCT FROM supplier_invoice_id)),
  CONSTRAINT cost_adjustments_tx_parts_chk CHECK (transaction_id IS NOT NULL OR (container_id IS NULL AND exception_id IS NULL)),
  CONSTRAINT cost_adjustments_review_chk CHECK ((status = 'proposed') = (reviewed_at IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.cost_adjustments IS 'G4 exceptional fees and adjustments (late cost, empty / washing / repair fees, amendments, duplicate invoices). Each one has a document and a reason.';
CREATE INDEX IF NOT EXISTS cost_adjustments_tx_idx ON public.cost_adjustments (transaction_id);
CREATE INDEX IF NOT EXISTS cost_adjustments_invoice_idx ON public.cost_adjustments (supplier_invoice_id);

CREATE TABLE IF NOT EXISTS public.cost_accruals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  transaction_id    uuid NOT NULL,
  container_id      uuid,
  source            text NOT NULL CHECK (source IN ('trip','demurrage','adjustment','manual')),
  trip_id           uuid,
  demurrage_case_id uuid,
  adjustment_id     uuid,
  supplier_id       uuid,                                  -- carrier / operator; NULL = own fleet or unknown
  service_code      text,
  amount            numeric(14,2) CHECK (amount >= 0),     -- NULL = unknown
  currency          char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  basis             text NOT NULL DEFAULT 'estimated' CHECK (basis IN ('agreed','estimated')),
  matched_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (matched_amount >= 0),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','variance','void')),
  variance_reason   text CHECK (variance_reason IN ('amount_diff','trip_cost_changed_after_match','trip_cancelled_after_match','allocation_reversed')),
  variance_amount   numeric(14,2),
  pending_amount    numeric(14,2) CHECK (pending_amount >= 0),
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  review_note       text CHECK (char_length(review_note) <= 2000),
  void_reason       text CHECK (char_length(void_reason) <= 2000),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_accruals_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT cost_accruals_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT cost_accruals_trip_fk FOREIGN KEY (trip_id, transaction_id) REFERENCES public.transport_trips(id, transaction_id),
  CONSTRAINT cost_accruals_case_fk FOREIGN KEY (demurrage_case_id, transaction_id) REFERENCES public.demurrage_cases(id, transaction_id),
  CONSTRAINT cost_accruals_adjustment_fk FOREIGN KEY (adjustment_id, org_id) REFERENCES public.cost_adjustments(id, org_id),
  CONSTRAINT cost_accruals_supplier_fk FOREIGN KEY (supplier_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT cost_accruals_source_chk CHECK ((source = 'trip') = (trip_id IS NOT NULL)
                                             AND (source = 'demurrage') = (demurrage_case_id IS NOT NULL)
                                             AND (source = 'adjustment') = (adjustment_id IS NOT NULL)),
  CONSTRAINT cost_accruals_void_chk CHECK (status <> 'void' OR void_reason IS NOT NULL),
  UNIQUE (id, org_id),
  UNIQUE (id, transaction_id)
);
COMMENT ON TABLE public.cost_accruals IS 'G4 expected costs (carrier accrual per trip, demurrage estimate, approved fee, manual). Accrual ≠ payment; matched by approved allocations, never counted twice.';
CREATE UNIQUE INDEX IF NOT EXISTS cost_accruals_trip_uidx ON public.cost_accruals (trip_id) WHERE status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS cost_accruals_case_uidx ON public.cost_accruals (demurrage_case_id) WHERE status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS cost_accruals_adjustment_uidx ON public.cost_accruals (adjustment_id) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS cost_accruals_tx_idx ON public.cost_accruals (transaction_id);
CREATE INDEX IF NOT EXISTS cost_accruals_status_idx ON public.cost_accruals (org_id, status);

ALTER TABLE public.cost_adjustments DROP CONSTRAINT IF EXISTS cost_adjustments_accrual_fk;
ALTER TABLE public.cost_adjustments ADD CONSTRAINT cost_adjustments_accrual_fk
  FOREIGN KEY (accrual_id, org_id) REFERENCES public.cost_accruals(id, org_id);

CREATE TABLE IF NOT EXISTS public.cost_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  supplier_invoice_id uuid NOT NULL,
  line_id             uuid NOT NULL,
  transaction_id      uuid NOT NULL,
  container_id        uuid,
  trip_id             uuid,
  demurrage_case_id   uuid,
  accrual_id          uuid,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),   -- net, in the invoice currency
  share_pct           numeric(7,4) CHECK (share_pct > 0 AND share_pct <= 100),
  service_code        text,
  is_late             boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','reversed')),
  note                text CHECK (char_length(note) <= 2000),
  decided_by          uuid,
  decided_at          timestamptz,
  decision_note       text CHECK (char_length(decision_note) <= 2000),
  reversed_by         uuid,
  reversed_at         timestamptz,
  reverse_reason      text CHECK (char_length(reverse_reason) <= 2000),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_allocations_invoice_fk FOREIGN KEY (supplier_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id),
  CONSTRAINT cost_allocations_line_fk FOREIGN KEY (line_id, supplier_invoice_id) REFERENCES public.supplier_invoice_lines(id, supplier_invoice_id),
  CONSTRAINT cost_allocations_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT cost_allocations_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT cost_allocations_trip_fk FOREIGN KEY (trip_id, transaction_id) REFERENCES public.transport_trips(id, transaction_id),
  CONSTRAINT cost_allocations_case_fk FOREIGN KEY (demurrage_case_id, transaction_id) REFERENCES public.demurrage_cases(id, transaction_id),
  CONSTRAINT cost_allocations_accrual_fk FOREIGN KEY (accrual_id, transaction_id) REFERENCES public.cost_accruals(id, transaction_id),
  CONSTRAINT cost_allocations_decided_chk CHECK ((status IN ('approved','rejected','reversed')) = (decided_at IS NOT NULL)),
  CONSTRAINT cost_allocations_reversed_chk CHECK ((status = 'reversed') = (reversed_at IS NOT NULL AND reverse_reason IS NOT NULL)),
  UNIQUE (id, org_id),
  UNIQUE (id, transaction_id)
);
COMMENT ON TABLE public.cost_allocations IS 'G4 allocation of an invoice line (net) to a transaction / container / trip / demurrage case. Σ live allocations never exceeds the line net (tg_alloc_cap).';
CREATE INDEX IF NOT EXISTS cost_allocations_line_idx ON public.cost_allocations (line_id);
CREATE INDEX IF NOT EXISTS cost_allocations_tx_idx ON public.cost_allocations (transaction_id);
CREATE INDEX IF NOT EXISTS cost_allocations_accrual_idx ON public.cost_allocations (accrual_id) WHERE accrual_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_allocations_invoice_idx ON public.cost_allocations (supplier_invoice_id);

CREATE TABLE IF NOT EXISTS public.supplier_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  supplier_invoice_id  uuid NOT NULL,
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  currency             char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  paid_at              date NOT NULL,
  method               text NOT NULL CHECK (method IN ('bank_transfer','cash','cheque','card','offset','other')),
  payer                text NOT NULL DEFAULT 'company' CHECK (payer IN ('company','client')),
  client_id            uuid,
  reference            text CHECK (char_length(reference) <= 120),
  evidence_document_id uuid,
  status               text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','void')),
  void_reason          text CHECK (char_length(void_reason) <= 2000),
  voided_by            uuid,
  voided_at            timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT supplier_payments_invoice_fk FOREIGN KEY (supplier_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id),
  CONSTRAINT supplier_payments_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT supplier_payments_evidence_fk FOREIGN KEY (evidence_document_id, org_id) REFERENCES public.finance_documents(id, org_id),
  CONSTRAINT supplier_payments_payer_chk CHECK ((payer = 'client') = (client_id IS NOT NULL)),
  CONSTRAINT supplier_payments_proof_chk CHECK (reference IS NOT NULL OR evidence_document_id IS NOT NULL),
  CONSTRAINT supplier_payments_client_evidence_chk CHECK (payer <> 'client' OR evidence_document_id IS NOT NULL),
  CONSTRAINT supplier_payments_void_chk CHECK ((status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.supplier_payments IS 'G4 payment evidence against a supplier invoice (append-only; recorded → void). payer=client = the client paid the supplier directly (not company cash-out). Paid ≠ due ≠ revenue.';
CREATE INDEX IF NOT EXISTS supplier_payments_invoice_idx ON public.supplier_payments (supplier_invoice_id);
CREATE INDEX IF NOT EXISTS supplier_payments_org_idx ON public.supplier_payments (org_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS public.client_charges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  transaction_id     uuid NOT NULL,
  container_id       uuid,
  kind               text NOT NULL CHECK (kind IN ('service','internal_service','reimbursable')),
  service_code       text,
  description        text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  quantity           numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price         numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  net_amount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  vat_rate           numeric(5,2) NOT NULL DEFAULT 15 CHECK (vat_rate BETWEEN 0 AND 100),
  vat_amount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  total_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency           char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','from_cost','markup','from_trip')),
  cost_allocation_id uuid,
  accrual_id         uuid,
  trip_id            uuid,
  demurrage_case_id  uuid,
  markup_pct         numeric(7,2) CHECK (markup_pct >= 0 AND markup_pct <= 1000),
  cost_snapshot      numeric(14,2) CHECK (cost_snapshot >= 0),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','invoiced','void')),
  approved_by        uuid,
  approved_at        timestamptz,
  void_reason        text CHECK (char_length(void_reason) <= 2000),
  note               text CHECK (char_length(note) <= 2000),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_charges_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT client_charges_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT client_charges_allocation_fk FOREIGN KEY (cost_allocation_id, transaction_id) REFERENCES public.cost_allocations(id, transaction_id),
  CONSTRAINT client_charges_accrual_fk FOREIGN KEY (accrual_id, transaction_id) REFERENCES public.cost_accruals(id, transaction_id),
  CONSTRAINT client_charges_trip_fk FOREIGN KEY (trip_id, transaction_id) REFERENCES public.transport_trips(id, transaction_id),
  CONSTRAINT client_charges_case_fk FOREIGN KEY (demurrage_case_id, transaction_id) REFERENCES public.demurrage_cases(id, transaction_id),
  CONSTRAINT client_charges_total_chk CHECK (total_amount = net_amount + vat_amount),
  -- price independent of cost: a cost link exists only for sourced charges (exactly one)
  CONSTRAINT client_charges_source_chk CHECK (CASE WHEN source IN ('from_cost','markup')
                                                   THEN num_nonnulls(cost_allocation_id, accrual_id) = 1 AND cost_snapshot IS NOT NULL
                                                   ELSE cost_allocation_id IS NULL AND accrual_id IS NULL END),
  CONSTRAINT client_charges_markup_chk CHECK ((source = 'markup') = (markup_pct IS NOT NULL)),
  CONSTRAINT client_charges_trip_chk CHECK (source <> 'from_trip' OR trip_id IS NOT NULL),
  CONSTRAINT client_charges_void_chk CHECK (status <> 'void' OR void_reason IS NOT NULL),
  UNIQUE (id, org_id),
  UNIQUE (id, transaction_id)
);
COMMENT ON TABLE public.client_charges IS 'G4 sell side per transaction (service, internal service, reimbursable disbursement). Not an invoice: invoiced is set by G5 only.';
CREATE UNIQUE INDEX IF NOT EXISTS client_charges_allocation_uidx ON public.client_charges (cost_allocation_id) WHERE status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS client_charges_accrual_uidx ON public.client_charges (accrual_id) WHERE status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS client_charges_trip_uidx ON public.client_charges (trip_id) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS client_charges_tx_idx ON public.client_charges (transaction_id);

CREATE TABLE IF NOT EXISTS public.charge_collections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  charge_id            uuid NOT NULL,
  transaction_id       uuid NOT NULL,
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  currency             char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  collected_at         date NOT NULL DEFAULT current_date,
  method               text NOT NULL CHECK (method IN ('bank_transfer','cash','cheque','card','offset','other')),
  reference            text CHECK (char_length(reference) <= 120),
  evidence_document_id uuid,
  status               text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','void')),
  void_reason          text CHECK (char_length(void_reason) <= 2000),
  voided_by            uuid,
  voided_at            timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT charge_collections_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT charge_collections_charge_fk FOREIGN KEY (charge_id, transaction_id) REFERENCES public.client_charges(id, transaction_id),
  CONSTRAINT charge_collections_evidence_fk FOREIGN KEY (evidence_document_id, org_id) REFERENCES public.finance_documents(id, org_id),
  CONSTRAINT charge_collections_proof_chk CHECK (reference IS NOT NULL OR evidence_document_id IS NOT NULL),
  CONSTRAINT charge_collections_void_chk CHECK ((status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.charge_collections IS 'G4 evidence that the client paid a charge (amount, reference, file). Not a receipt: Daftra is the source of truth in G5. Append-only.';
CREATE INDEX IF NOT EXISTS charge_collections_charge_idx ON public.charge_collections (charge_id);

-- ---------------------------------------------------------------------
-- 3. supplier invoices — helpers
-- ---------------------------------------------------------------------
-- policy helper (runs as the caller): finance read role at the invoice's branch
CREATE OR REPLACE FUNCTION app.fin_can_read_invoice(p_si uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.supplier_invoices si
                  WHERE si.id = p_si AND app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()))
$$;

-- the caller may approve / reject a row created by p_creator at that branch (fin_approve there + four eyes, admin excepted)
CREATE OR REPLACE FUNCTION app.fin_can_decide(p_org uuid, p_branch uuid, p_creator uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.has_branch_role(p_org, p_branch, app.fin_approve_roles())
     AND (p_creator IS DISTINCT FROM auth.uid() OR app.has_role(p_org, ARRAY['admin']))
$$;

-- storage path of a non-voided finance document (readers call it inside an RPC already gated at the record's branch;
-- the document's branch equals the record's, see app.fin_check_findoc)
CREATE OR REPLACE FUNCTION app.fin_doc_path(p_doc uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.storage_path FROM public.finance_documents f WHERE f.id = p_doc AND f.voided_at IS NULL
$$;

-- what is owed on an invoice: total − approved credit notes against it (≥ 0). Debit notes stay their own payable rows.
CREATE OR REPLACE FUNCTION app.fin_invoice_payable(p_si uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT greatest(si.total_amount - CASE WHEN si.doc_type = 'invoice'
           THEN coalesce((SELECT sum(cn.total_amount) FROM public.supplier_invoices cn
                           WHERE cn.adjusts_invoice_id = si.id AND cn.doc_type = 'credit_note' AND cn.status = 'approved'), 0)
           ELSE 0 END, 0)
    FROM public.supplier_invoices si WHERE si.id = p_si
$$;

-- paid above the payable (a credit note approved after payment): owed back by the supplier, never an error
CREATE OR REPLACE FUNCTION app.fin_invoice_credit_due(p_si uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT greatest(si.company_paid_amount + si.client_paid_amount - app.fin_invoice_payable(si.id), 0)
    FROM public.supplier_invoices si WHERE si.id = p_si
$$;

-- share of an invoice that ONE client paid directly, spread only over that client's approved allocations (by gross):
-- least(Σ its recorded payer='client' payments / Σ gross of its approved allocations on the invoice, 1); 0 when none.
CREATE OR REPLACE FUNCTION app.fin_client_share(p_si uuid, p_client uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH cp AS (SELECT coalesce(sum(sp.amount), 0) amt FROM public.supplier_payments sp
               WHERE sp.supplier_invoice_id = p_si AND sp.status = 'recorded' AND sp.payer = 'client' AND sp.client_id = p_client),
       cg AS (SELECT coalesce(sum(CASE WHEN l.net_amount > 0 THEN a.amount * l.total_amount / l.net_amount ELSE a.amount END), 0) amt
                FROM public.cost_allocations a JOIN public.supplier_invoice_lines l ON l.id = a.line_id
                JOIN public.transactions t ON t.id = a.transaction_id
               WHERE a.supplier_invoice_id = p_si AND a.status = 'approved' AND t.client_id = p_client)
  SELECT CASE WHEN p_client IS NULL OR cp.amt = 0 OR cg.amt <= 0 THEN 0 ELSE least(cp.amt / cg.amt, 1) END FROM cp, cg
$$;

CREATE OR REPLACE FUNCTION app.tg_supplier_invoices_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.invoice_number := btrim(NEW.invoice_number);
  NEW.number_norm := app.fin_norm_no(NEW.invoice_number);
  IF NEW.number_norm = '' THEN PERFORM app.fail('MRS_INVALID', 'invoice_number'); END IF;
  NEW.reference := nullif(btrim(coalesce(NEW.reference, '')), '');
  IF TG_OP = 'UPDATE' THEN
    -- scope and identity never move
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      PERFORM app.fail('MRS_IMMUTABLE', 'supplier_invoice');
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.supplier_invoices;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.supplier_invoices FOR EACH ROW EXECUTE FUNCTION app.tg_supplier_invoices_before();

-- re-run safety: rows stored with an older normalization are recomputed (preflight: the new form must not collide)
DO $norm$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(x.k, '; ') INTO v_bad FROM (
    SELECT si.supplier_id::text || ' ' || si.doc_type || ' ' || app.fin_norm_no(si.invoice_number) k
      FROM public.supplier_invoices si WHERE si.status <> 'void'
     GROUP BY si.org_id, si.supplier_id, si.doc_type, app.fin_norm_no(si.invoice_number) HAVING count(*) > 1) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'G4 preflight: the invoice-number normalization would merge live invoices (%) — void or renumber them first', v_bad;
  END IF;
  UPDATE public.supplier_invoices si SET number_norm = app.fin_norm_no(si.invoice_number)
   WHERE si.number_norm IS DISTINCT FROM app.fin_norm_no(si.invoice_number);
END $norm$;

-- header vs ALL lines (excluded included: they are on paper)
CREATE OR REPLACE FUNCTION app.fin_invoice_discrepancy(p_si uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'net',   si.subtotal - coalesce(sum(l.net_amount), 0),
    'vat',   si.vat_amount - coalesce(sum(l.vat_amount), 0),
    'total', si.total_amount - coalesce(sum(l.total_amount), 0),
    'lines_net', coalesce(sum(l.net_amount), 0), 'lines_vat', coalesce(sum(l.vat_amount), 0),
    'lines_total', coalesce(sum(l.total_amount), 0), 'line_count', count(l.id))
    FROM public.supplier_invoices si LEFT JOIN public.supplier_invoice_lines l ON l.supplier_invoice_id = si.id
   WHERE si.id = p_si
   GROUP BY si.id, si.subtotal, si.vat_amount, si.total_amount
$$;

-- soft duplicates (warning, never blocking), limited to invoices the caller may read:
--   same supplier + same total + date within ±7 days + another number  → same_supplier_total_date
--   same number_norm under another supplier                             → same_number_other_supplier
--   same file (finance original or transaction document sha256)         → same_file
CREATE OR REPLACE FUNCTION app.fin_possible_duplicates(p_org uuid, p_supplier uuid, p_norm text, p_date date, p_total numeric,
  p_sha text, p_exclude uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'invoice_number', x.invoice_number, 'supplier_id', x.supplier_id,
           'invoice_date', x.invoice_date, 'total_amount', x.total_amount, 'currency', x.currency, 'status', x.status,
           'reasons', to_jsonb(x.reasons)) ORDER BY x.invoice_date, x.id), '[]'::jsonb)
    FROM (
      SELECT si.id, si.invoice_number, si.supplier_id, si.invoice_date, si.total_amount, si.currency, si.status,
             array_remove(ARRAY[
               CASE WHEN si.supplier_id = p_supplier AND p_total IS NOT NULL AND si.total_amount = p_total
                         AND p_date IS NOT NULL AND abs(si.invoice_date - p_date) <= 7 AND si.number_norm <> coalesce(p_norm, '')
                    THEN 'same_supplier_total_date' END,
               CASE WHEN si.supplier_id <> p_supplier AND si.number_norm = p_norm THEN 'same_number_other_supplier' END,
               -- same digits once the kept separators are dropped ('A-1-23' vs 'A-12-3'): a warning, never a block
               CASE WHEN si.supplier_id = p_supplier AND si.number_norm <> coalesce(p_norm, '')
                         AND replace(si.number_norm, '-', '') = replace(coalesce(p_norm, ''), '-', '') THEN 'similar_number' END,
               CASE WHEN p_sha IS NOT NULL AND (
                      EXISTS (SELECT 1 FROM public.finance_documents f WHERE f.id = si.finance_document_id AND f.sha256 = p_sha)
                      OR EXISTS (SELECT 1 FROM public.documents d WHERE d.id = si.source_document_id AND d.sha256 = p_sha))
                    THEN 'same_file' END], NULL) AS reasons
        FROM public.supplier_invoices si
       WHERE si.org_id = p_org AND si.status <> 'void' AND si.id IS DISTINCT FROM p_exclude
         AND app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles())) x
   WHERE cardinality(x.reasons) > 0
$$;

-- sha256 of an invoice's original (finance document first, then the transaction document)
CREATE OR REPLACE FUNCTION app.fin_invoice_sha(p_si public.supplier_invoices) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT f.sha256 FROM public.finance_documents f WHERE f.id = p_si.finance_document_id),
                  (SELECT d.sha256 FROM public.documents d WHERE d.id = p_si.source_document_id))
$$;

-- lock an invoice the caller may read (else MRS_NOT_FOUND) with one of p_roles at its branch (else MRS_FORBIDDEN 'role')
CREATE OR REPLACE FUNCTION app.fin_lock_invoice(p_si uuid, p_roles text[]) RETURNS public.supplier_invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.supplier_invoices;
BEGIN
  SELECT * INTO v FROM public.supplier_invoices si WHERE si.id = p_si FOR UPDATE;
  IF v.id IS NULL OR NOT app.has_branch_role(v.org_id, v.branch_id, app.fin_read_roles()) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'supplier_invoice');
  END IF;
  IF NOT app.has_branch_role(v.org_id, v.branch_id, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.fin_invoice_editable(p_si public.supplier_invoices) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_si.status NOT IN ('received','under_review','disputed') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'invoice_locked'); END IF;
END $$;

-- a finance original of the org AND of the owning record's branch (not voided): the file's read scope (RLS on
-- finance_documents / storage follows the document's branch) must equal the record's / a transaction document of the org
DROP FUNCTION IF EXISTS app.fin_check_findoc(uuid, uuid, text);
CREATE OR REPLACE FUNCTION app.fin_check_findoc(p_org uuid, p_branch uuid, p_id uuid, p_field text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.finance_documents f
       WHERE f.id = p_id AND f.org_id = p_org AND f.branch_id = p_branch AND f.voided_at IS NULL
         AND app.has_branch_role(f.org_id, f.branch_id, app.fin_read_roles())) THEN
    PERFORM app.fail('MRS_INVALID', p_field);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION app.fin_check_txdoc(p_org uuid, p_id uuid, p_field text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.documents d
       WHERE d.id = p_id AND d.org_id = p_org AND d.voided_at IS NULL
         AND (d.transaction_id IS NULL OR app.has_tx_role(d.transaction_id, app.staff_roles()))) THEN
    PERFORM app.fail('MRS_INVALID', p_field);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. lines — auto review
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fin_unreadable() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '(بند غير مقروء)'::text $$;

CREATE OR REPLACE FUNCTION app.fin_line_review_reasons(l public.supplier_invoice_lines) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN l.service_code IS NULL THEN 'no_service' END,
    CASE WHEN l.unit_price IS NOT NULL AND abs(l.quantity * l.unit_price - l.net_amount) > 0.05 THEN 'qty_price_mismatch' END,
    CASE WHEN abs(l.net_amount * l.vat_rate / 100 - l.vat_amount) > 0.05 THEN 'vat_mismatch' END,
    CASE WHEN l.source IN ('ocr','import') THEN 'from_ocr' END,
    CASE WHEN l.description = app.fin_unreadable() THEN 'unreadable' END], NULL)
$$;

-- reasons recomputed on every write; the status follows them on insert and on a content change
-- (a reviewer's explicit decision — review_status set in the same UPDATE — is kept)
CREATE OR REPLACE FUNCTION app.tg_invoice_lines_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_r text[];
BEGIN
  NEW.description := coalesce(nullif(btrim(NEW.description), ''), app.fin_unreadable());
  NEW.total_amount := NEW.net_amount + NEW.vat_amount;
  v_r := app.fin_line_review_reasons(NEW);
  NEW.review_reasons := v_r;
  IF TG_OP = 'INSERT' THEN
    NEW.review_status := CASE WHEN cardinality(v_r) > 0 THEN 'pending_review' ELSE 'ok' END;
  ELSE
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id THEN
      PERFORM app.fail('MRS_IMMUTABLE', 'supplier_invoice_id');
    END IF;
    IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status
       AND (NEW.description, NEW.quantity, NEW.unit_price, NEW.net_amount, NEW.vat_rate, NEW.vat_amount, NEW.source, NEW.service_code)
           IS DISTINCT FROM (OLD.description, OLD.quantity, OLD.unit_price, OLD.net_amount, OLD.vat_rate, OLD.vat_amount, OLD.source, OLD.service_code) THEN
      NEW.review_status := CASE WHEN cardinality(v_r) > 0 THEN 'pending_review' ELSE 'ok' END;
      NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_review ON public.supplier_invoice_lines;
CREATE TRIGGER trg_review BEFORE INSERT OR UPDATE ON public.supplier_invoice_lines FOR EACH ROW EXECUTE FUNCTION app.tg_invoice_lines_review();

-- one payload line → normalized fields (net from qty × unit price when absent; VAT from the rate when absent)
CREATE OR REPLACE FUNCTION app.fin_line_fields(p jsonb, p_partial boolean, p_old public.supplier_invoice_lines DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_desc text; v_qty numeric; v_up numeric; v_net numeric; v_rate numeric; v_vat numeric; v_tot numeric; v_svc text;
  v_unit text; v_cno text; v_ref text; n numeric;
BEGIN
  PERFORM app.only_keys(p, ARRAY['line_no','description','quantity','unit','unit_price','net_amount','vat_rate','vat_amount',
                                 'total_amount','service_code','container_no_hint','reference_hint']);
  v_desc := CASE WHEN p ? 'description' OR NOT p_partial THEN app.ptext(p, 'description', 500) ELSE p_old.description END;
  v_qty := CASE WHEN p ? 'quantity' OR NOT p_partial THEN app.pnum(p, 'quantity', 99999999999) ELSE p_old.quantity END;
  IF v_qty IS NULL THEN v_qty := 1; END IF;
  IF v_qty <= 0 OR v_qty <> round(v_qty, 3) THEN PERFORM app.fail('MRS_INVALID', 'quantity'); END IF;
  v_up := CASE WHEN p ? 'unit_price' OR NOT p_partial THEN app.fin_money(p, 'unit_price') ELSE p_old.unit_price END;
  v_rate := CASE WHEN p ? 'vat_rate' OR NOT p_partial THEN app.pnum(p, 'vat_rate', 100) ELSE p_old.vat_rate END;
  IF v_rate IS NULL THEN v_rate := 15; END IF;
  v_tot := app.fin_money(p, 'total_amount');
  v_net := CASE WHEN p ? 'net_amount' THEN app.fin_money(p, 'net_amount')
                WHEN p_partial AND NOT (p ? 'quantity' OR p ? 'unit_price') THEN p_old.net_amount END;
  v_vat := CASE WHEN p ? 'vat_amount' THEN app.fin_money(p, 'vat_amount')
                WHEN p_partial AND NOT (p ? 'net_amount' OR p ? 'vat_rate' OR p ? 'quantity' OR p ? 'unit_price') THEN p_old.vat_amount END;
  IF v_net IS NULL AND v_up IS NOT NULL THEN v_net := round(v_qty * v_up, 2); END IF;
  IF v_net IS NULL AND v_tot IS NOT NULL AND v_vat IS NOT NULL THEN v_net := v_tot - v_vat; END IF;
  IF v_net IS NULL AND v_tot IS NOT NULL THEN v_net := round(v_tot / (1 + v_rate / 100), 2); END IF;
  IF v_net IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'net_amount'); END IF;
  IF v_net < 0 THEN PERFORM app.fail('MRS_INVALID', 'net_amount'); END IF;
  IF v_vat IS NULL THEN v_vat := CASE WHEN v_tot IS NOT NULL THEN v_tot - v_net ELSE round(v_net * v_rate / 100, 2) END; END IF;
  IF v_vat < 0 THEN PERFORM app.fail('MRS_INVALID', 'vat_amount'); END IF;
  IF v_tot IS NOT NULL AND v_tot <> v_net + v_vat THEN PERFORM app.fail('MRS_INVALID', 'total_amount'); END IF;
  -- an amount with no readable description is kept with a placeholder (review reason 'unreadable')
  IF v_desc IS NULL THEN v_desc := app.fin_unreadable(); END IF;
  v_svc := CASE WHEN p ? 'service_code' OR NOT p_partial THEN app.ptext(p, 'service_code', 40) ELSE p_old.service_code END;
  PERFORM app.fin_check_service(v_svc);
  v_unit := CASE WHEN p ? 'unit' OR NOT p_partial THEN app.ptext(p, 'unit', 20) ELSE p_old.unit END;
  v_cno := CASE WHEN p ? 'container_no_hint' OR NOT p_partial THEN upper(app.ptext(p, 'container_no_hint', 20)) ELSE p_old.container_no_hint END;
  v_ref := CASE WHEN p ? 'reference_hint' OR NOT p_partial THEN app.ptext(p, 'reference_hint', 120) ELSE p_old.reference_hint END;
  n := app.pnum(p, 'line_no', 999);
  IF n IS NOT NULL AND (n < 1 OR n <> trunc(n)) THEN PERFORM app.fail('MRS_INVALID', 'line_no'); END IF;
  RETURN jsonb_build_object('line_no', n, 'description', v_desc, 'quantity', v_qty, 'unit', v_unit, 'unit_price', v_up,
    'net_amount', v_net, 'vat_rate', v_rate, 'vat_amount', v_vat, 'service_code', v_svc,
    'container_no_hint', v_cno, 'reference_hint', v_ref);
END $$;

-- insert lines (≤ 200) on an editable invoice; returns the new rows
CREATE OR REPLACE FUNCTION app.fin_insert_lines(p_si public.supplier_invoices, p_lines jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_e jsonb; v_f jsonb; v_no int; v_l public.supplier_invoice_lines; v_out jsonb := '[]'::jsonb;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'lines'); END IF;
  IF jsonb_array_length(p_lines) > 200 THEN PERFORM app.fail('MRS_TOO_LONG', 'lines'); END IF;
  IF p_source NOT IN ('manual','ocr','import') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
  PERFORM app.fin_invoice_editable(p_si);
  SELECT coalesce(max(l.line_no), 0) INTO v_no FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = p_si.id;
  FOR v_e IN SELECT e FROM jsonb_array_elements(p_lines) e LOOP
    IF jsonb_typeof(v_e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'lines'); END IF;
    v_f := app.fin_line_fields(v_e, false);
    v_no := coalesce((v_f ->> 'line_no')::int, v_no + 1);
    IF v_no > 999 THEN PERFORM app.fail('MRS_TOO_LONG', 'lines'); END IF;
    IF EXISTS (SELECT 1 FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = p_si.id AND l.line_no = v_no) THEN
      PERFORM app.fail('MRS_INVALID', 'line_no_taken');
    END IF;
    INSERT INTO public.supplier_invoice_lines (org_id, supplier_invoice_id, line_no, description, quantity, unit, unit_price,
      net_amount, vat_rate, vat_amount, total_amount, service_code, container_no_hint, reference_hint, source, created_by)
    VALUES (p_si.org_id, p_si.id, v_no, v_f ->> 'description', (v_f ->> 'quantity')::numeric, v_f ->> 'unit',
      (v_f ->> 'unit_price')::numeric, (v_f ->> 'net_amount')::numeric, (v_f ->> 'vat_rate')::numeric,
      (v_f ->> 'vat_amount')::numeric, (v_f ->> 'net_amount')::numeric + (v_f ->> 'vat_amount')::numeric,
      v_f ->> 'service_code', v_f ->> 'container_no_hint', v_f ->> 'reference_hint', p_source, auth.uid())
    RETURNING * INTO v_l;
    v_out := v_out || jsonb_build_array(to_jsonb(v_l));
  END LOOP;
  RETURN v_out;
END $$;

-- payload → normalized header fields (keys present only)
DROP FUNCTION IF EXISTS app.fin_invoice_fields(jsonb, uuid);
CREATE OR REPLACE FUNCTION app.fin_invoice_fields(p jsonb, p_org uuid, p_branch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; s text;
BEGIN
  IF p ? 'invoice_number' THEN
    s := app.ptext(p, 'invoice_number', 60, true);
    IF app.fin_norm_no(s) = '' THEN PERFORM app.fail('MRS_INVALID', 'invoice_number'); END IF;
    v := v || jsonb_build_object('invoice_number', s);
  END IF;
  IF p ? 'invoice_date' THEN
    IF app.pdate(p, 'invoice_date') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'invoice_date'); END IF;
    v := v || jsonb_build_object('invoice_date', app.pdate(p, 'invoice_date'));
  END IF;
  IF p ? 'due_date' THEN v := v || jsonb_build_object('due_date', app.pdate(p, 'due_date')); END IF;
  IF p ? 'received_at' THEN v := v || jsonb_build_object('received_at', coalesce(app.pts(p, 'received_at'), now())); END IF;
  IF p ? 'currency' THEN v := v || jsonb_build_object('currency', coalesce(app.fin_currency(p, 'currency'), 'SAR')); END IF;
  IF p ? 'subtotal' THEN v := v || jsonb_build_object('subtotal', app.fin_money(p, 'subtotal')); END IF;
  IF p ? 'vat_amount' THEN v := v || jsonb_build_object('vat_amount', app.fin_money(p, 'vat_amount')); END IF;
  IF p ? 'total_amount' THEN v := v || jsonb_build_object('total_amount', app.fin_money(p, 'total_amount')); END IF;
  IF p ? 'reference' THEN v := v || jsonb_build_object('reference', app.ptext(p, 'reference', 120)); END IF;
  IF p ? 'supplier_vat_number' THEN
    s := app.digits(app.ptext(p, 'supplier_vat_number', 20));
    IF s IS NOT NULL AND s !~ '^[0-9]{15}$' THEN PERFORM app.fail('MRS_INVALID', 'supplier_vat_number'); END IF;
    v := v || jsonb_build_object('supplier_vat_number', s);
  END IF;
  IF p ? 'finance_document_id' THEN
    v := v || jsonb_build_object('finance_document_id', app.puuid(p, 'finance_document_id'));
    PERFORM app.fin_check_findoc(p_org, p_branch, (v ->> 'finance_document_id')::uuid, 'finance_document_id');
  END IF;
  IF p ? 'source_document_id' THEN
    v := v || jsonb_build_object('source_document_id', app.puuid(p, 'source_document_id'));
    PERFORM app.fin_check_txdoc(p_org, (v ->> 'source_document_id')::uuid, 'source_document_id');
  END IF;
  IF p ? 'notes' THEN v := v || jsonb_build_object('notes', app.ptext(p, 'notes', 2000)); END IF;
  RETURN v;
END $$;

-- subtotal / vat / total: total = subtotal + vat (a missing one is derived)
CREATE OR REPLACE FUNCTION app.fin_amounts(p_sub numeric, p_vat numeric, p_tot numeric) RETURNS numeric[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE s numeric := p_sub; v numeric := coalesce(p_vat, 0); t numeric := p_tot;
BEGIN
  IF s IS NULL AND t IS NOT NULL THEN s := t - v; END IF;
  s := coalesce(s, 0);
  IF t IS NULL THEN t := s + v; END IF;
  IF s < 0 THEN PERFORM app.fail('MRS_INVALID', 'subtotal'); END IF;
  IF t <> s + v THEN PERFORM app.fail('MRS_INVALID', 'total_amount'); END IF;
  RETURN ARRAY[s, v, t];
END $$;

CREATE OR REPLACE FUNCTION app.fin_number_check(p_org uuid, p_supplier uuid, p_doc_type text, p_number text, p_exclude uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  SELECT si.id INTO v_id FROM public.supplier_invoices si
   WHERE si.org_id = p_org AND si.supplier_id = p_supplier AND si.doc_type = p_doc_type
     AND si.number_norm = app.fin_norm_no(p_number) AND si.status <> 'void' AND si.id IS DISTINCT FROM p_exclude
   LIMIT 1;
  IF v_id IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'invoice_number_taken', v_id::text); END IF;
END $$;

-- credit / debit note vs the invoice it adjusts (locked FOR UPDATE: serialises against payments and other notes):
-- same currency; a credit note never takes the original below zero — Σ total of the non-void credit notes on it ≤ its total.
CREATE OR REPLACE FUNCTION app.fin_check_credit_cap(p_adj uuid, p_self uuid, p_doc_type text, p_total numeric, p_currency text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.supplier_invoices; v_other numeric;
BEGIN
  IF p_adj IS NULL OR p_doc_type = 'invoice' THEN RETURN; END IF;
  SELECT * INTO o FROM public.supplier_invoices si WHERE si.id = p_adj FOR UPDATE;
  IF o.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'adjusts_invoice_id'); END IF;
  IF p_currency IS DISTINCT FROM o.currency::text THEN PERFORM app.fail('MRS_INVALID', 'currency'); END IF;
  IF p_doc_type <> 'credit_note' THEN RETURN; END IF;
  SELECT coalesce(sum(cn.total_amount), 0) INTO v_other FROM public.supplier_invoices cn
   WHERE cn.adjusts_invoice_id = o.id AND cn.doc_type = 'credit_note' AND cn.status <> 'void' AND cn.id IS DISTINCT FROM p_self;
  IF v_other + coalesce(p_total, 0) > o.total_amount THEN
    PERFORM app.fin_fail('MRS_INVALID', 'credit_exceeds_invoice', greatest(o.total_amount - v_other, 0)::text);
  END IF;
END $$;

-- a credit-note line may only reduce a transaction that carries the adjusted invoice's approved cost, and never below 0:
-- Σ live allocations of the credit notes on that invoice, on that transaction (+ p_amount) ≤ its approved allocations there.
-- p_live = false (approval re-check): only approved credit allocations count, p_self excluded.
CREATE OR REPLACE FUNCTION app.fin_check_credit_target(p_cn public.supplier_invoices, p_tx uuid, p_amount numeric, p_self uuid, p_live boolean)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_orig numeric; v_cr numeric;
BEGIN
  IF p_cn.doc_type <> 'credit_note' THEN RETURN; END IF;
  SELECT coalesce(sum(a.amount), 0) INTO v_orig FROM public.cost_allocations a
   WHERE a.supplier_invoice_id = p_cn.adjusts_invoice_id AND a.transaction_id = p_tx AND a.status = 'approved';
  SELECT coalesce(sum(a.amount), 0) INTO v_cr FROM public.cost_allocations a JOIN public.supplier_invoices cn ON cn.id = a.supplier_invoice_id
   WHERE cn.adjusts_invoice_id = p_cn.adjusts_invoice_id AND cn.doc_type = 'credit_note' AND cn.status <> 'void'
     AND a.transaction_id = p_tx AND a.id IS DISTINCT FROM p_self
     AND (a.status = 'approved' OR (p_live AND a.status = 'proposed'));
  IF v_orig <= 0 OR v_cr + p_amount > v_orig THEN
    PERFORM app.fin_fail('MRS_INVALID', 'credit_target', greatest(v_orig - v_cr, 0)::text);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3./4. invoice + line RPCs
-- ---------------------------------------------------------------------
-- create_supplier_invoice({branch_id, supplier_id, doc_type?, adjusts_invoice_id?, invoice_number, invoice_date, due_date?,
--   received_at?, currency?, subtotal?, vat_amount?, total_amount?, reference?, supplier_vat_number?, finance_document_id?,
--   source_document_id?, notes?, lines?[]}, p_idem_key) → invoice + possible_duplicates (+ lines)
CREATE OR REPLACE FUNCTION public.create_supplier_invoice(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_br public.branches; v_brid uuid; v_replay jsonb; v_sup public.parties; v_supid uuid; v_f jsonb; v_doc text;
  v_adj uuid; v_amt numeric[]; v_si public.supplier_invoices; v_lines jsonb; v_res jsonb; v_cur text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['branch_id','supplier_id','doc_type','adjusts_invoice_id','invoice_number','invoice_date',
    'due_date','received_at','currency','subtotal','vat_amount','total_amount','reference','supplier_vat_number',
    'finance_document_id','source_document_id','notes','lines','idempotencyKey']);
  v_brid := app.puuid(p_payload, 'branch_id');
  IF v_brid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'branch_id'); END IF;
  SELECT * INTO v_br FROM public.branches b WHERE b.id = v_brid;
  IF v_br.id IS NULL OR NOT app.is_staff(v_br.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'branch'); END IF;
  IF NOT app.has_branch_role(v_br.org_id, v_br.id, app.fin_write_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('create_supplier_invoice', p_idem_key, p_payload - 'idempotencyKey', v_br.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_supid := app.puuid(p_payload, 'supplier_id');
  IF v_supid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'supplier_id'); END IF;
  SELECT * INTO v_sup FROM public.parties pa WHERE pa.id = v_supid AND pa.org_id = v_br.org_id AND pa.is_active;
  IF v_sup.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'supplier_id'); END IF;
  v_doc := coalesce(app.ptext(p_payload, 'doc_type', 20), 'invoice');
  IF v_doc NOT IN ('invoice','credit_note','debit_note') THEN PERFORM app.fail('MRS_INVALID', 'doc_type'); END IF;
  v_adj := app.puuid(p_payload, 'adjusts_invoice_id');
  IF v_doc = 'invoice' AND v_adj IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'adjusts_invoice_id'); END IF;
  IF v_doc <> 'invoice' THEN
    IF v_adj IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'adjusts_invoice_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.supplier_invoices si WHERE si.id = v_adj AND si.org_id = v_br.org_id
                     AND si.supplier_id = v_sup.id AND si.doc_type = 'invoice' AND si.status <> 'void') THEN
      PERFORM app.fail('MRS_INVALID', 'adjusts_invoice_id');
    END IF;
  END IF;
  IF NOT (p_payload ? 'invoice_number') THEN PERFORM app.fail('MRS_REQUIRED', 'invoice_number'); END IF;
  IF NOT (p_payload ? 'invoice_date') THEN PERFORM app.fail('MRS_REQUIRED', 'invoice_date'); END IF;
  v_f := app.fin_invoice_fields(p_payload - 'idempotencyKey' - 'branch_id' - 'supplier_id' - 'doc_type' - 'adjusts_invoice_id' - 'lines',
                                v_br.org_id, v_br.id);
  IF (v_f ->> 'due_date')::date < (v_f ->> 'invoice_date')::date THEN PERFORM app.fail('MRS_INVALID', 'due_date'); END IF;
  v_amt := app.fin_amounts((v_f ->> 'subtotal')::numeric, (v_f ->> 'vat_amount')::numeric, (v_f ->> 'total_amount')::numeric);
  PERFORM app.fin_number_check(v_br.org_id, v_sup.id, v_doc, v_f ->> 'invoice_number', NULL);
  -- a note is in the currency of the invoice it adjusts; a credit note never exceeds what is left of it
  v_cur := coalesce(v_f ->> 'currency', (SELECT si.currency::text FROM public.supplier_invoices si WHERE si.id = v_adj),
                    v_sup.default_currency, 'SAR');
  PERFORM app.fin_check_credit_cap(v_adj, NULL, v_doc, v_amt[3], v_cur);

  INSERT INTO public.supplier_invoices (org_id, branch_id, supplier_id, doc_type, adjusts_invoice_id, invoice_number, number_norm,
    invoice_date, due_date, received_at, currency, subtotal, vat_amount, total_amount, reference, supplier_vat_number,
    finance_document_id, source_document_id, notes, created_by)
  VALUES (v_br.org_id, v_br.id, v_sup.id, v_doc, v_adj, v_f ->> 'invoice_number', app.fin_norm_no(v_f ->> 'invoice_number'),
    (v_f ->> 'invoice_date')::date, (v_f ->> 'due_date')::date,
    coalesce((v_f ->> 'received_at')::timestamptz, now()),
    v_cur, v_amt[1], v_amt[2], v_amt[3], v_f ->> 'reference',
    coalesce(v_f ->> 'supplier_vat_number', v_sup.vat_number),
    (v_f ->> 'finance_document_id')::uuid, (v_f ->> 'source_document_id')::uuid, v_f ->> 'notes', auth.uid())
  RETURNING * INTO v_si;
  IF p_payload ? 'lines' AND jsonb_typeof(p_payload -> 'lines') = 'array' AND jsonb_array_length(p_payload -> 'lines') > 0 THEN
    v_lines := app.fin_insert_lines(v_si, p_payload -> 'lines', 'manual');
  ELSIF p_payload ? 'lines' AND jsonb_typeof(p_payload -> 'lines') NOT IN ('array','null') THEN
    PERFORM app.fail('MRS_INVALID', 'lines');
  END IF;
  v_res := to_jsonb(v_si) || jsonb_build_object(
    'lines', coalesce(v_lines, '[]'::jsonb),
    'discrepancy', app.fin_invoice_discrepancy(v_si.id),
    'possible_duplicates', app.fin_possible_duplicates(v_si.org_id, v_si.supplier_id, v_si.number_norm, v_si.invoice_date,
                                                       v_si.total_amount, app.fin_invoice_sha(v_si), v_si.id));
  RETURN app.idem_finish('create_supplier_invoice', p_idem_key, v_res);
END $$;

-- update_supplier_invoice(p_id, {invoice_number?, invoice_date?, due_date?, received_at?, currency?, subtotal?, vat_amount?,
--   total_amount?, reference?, supplier_vat_number?, finance_document_id?, source_document_id?, notes?}) — editable statuses only
CREATE OR REPLACE FUNCTION public.update_supplier_invoice(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_si public.supplier_invoices; v_f jsonb; v_amt numeric[]; v_new public.supplier_invoices; v_changed jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_si := app.fin_lock_invoice(p_id, app.fin_write_roles());
  PERFORM app.only_keys(p_payload, ARRAY['invoice_number','invoice_date','due_date','received_at','currency','subtotal','vat_amount',
    'total_amount','reference','supplier_vat_number','finance_document_id','source_document_id','notes']);
  IF p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  PERFORM app.fin_invoice_editable(v_si);
  v_f := app.fin_invoice_fields(p_payload, v_si.org_id, v_si.branch_id);
  IF v_f ? 'currency' AND (v_f ->> 'currency') IS DISTINCT FROM v_si.currency::text
     AND EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.supplier_invoice_id = v_si.id AND a.status IN ('proposed','approved')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'allocated');
  END IF;
  IF v_f ? 'currency' AND (v_f ->> 'currency') IS DISTINCT FROM v_si.currency::text
     AND EXISTS (SELECT 1 FROM public.supplier_payments sp WHERE sp.supplier_invoice_id = v_si.id AND sp.status = 'recorded') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'has_payments');
  END IF;
  IF v_f ? 'subtotal' OR v_f ? 'vat_amount' OR v_f ? 'total_amount' THEN
    v_amt := app.fin_amounts(CASE WHEN v_f ? 'subtotal' THEN (v_f ->> 'subtotal')::numeric
                                  WHEN v_f ? 'total_amount' THEN NULL ELSE v_si.subtotal END,
                             CASE WHEN v_f ? 'vat_amount' THEN (v_f ->> 'vat_amount')::numeric ELSE v_si.vat_amount END,
                             CASE WHEN v_f ? 'total_amount' THEN (v_f ->> 'total_amount')::numeric END);
    IF v_amt[3] < v_si.company_paid_amount + v_si.client_paid_amount THEN
      PERFORM app.fail('MRS_OVERPAID', (v_si.company_paid_amount + v_si.client_paid_amount - v_amt[3])::text);
    END IF;
  ELSE
    v_amt := ARRAY[v_si.subtotal, v_si.vat_amount, v_si.total_amount];
  END IF;
  IF v_f ? 'invoice_number' THEN PERFORM app.fin_number_check(v_si.org_id, v_si.supplier_id, v_si.doc_type, v_f ->> 'invoice_number', v_si.id); END IF;
  IF v_si.doc_type <> 'invoice' AND (v_f ? 'subtotal' OR v_f ? 'vat_amount' OR v_f ? 'total_amount' OR v_f ? 'currency') THEN
    PERFORM app.fin_check_credit_cap(v_si.adjusts_invoice_id, v_si.id, v_si.doc_type, v_amt[3], coalesce(v_f ->> 'currency', v_si.currency::text));
  END IF;
  IF coalesce((v_f ->> 'due_date')::date, CASE WHEN v_f ? 'due_date' THEN NULL ELSE v_si.due_date END)
     < coalesce((v_f ->> 'invoice_date')::date, v_si.invoice_date) THEN
    PERFORM app.fail('MRS_INVALID', 'due_date');
  END IF;
  UPDATE public.supplier_invoices si SET
    invoice_number      = coalesce(v_f ->> 'invoice_number', si.invoice_number),
    invoice_date        = coalesce((v_f ->> 'invoice_date')::date, si.invoice_date),
    due_date            = CASE WHEN v_f ? 'due_date' THEN (v_f ->> 'due_date')::date ELSE si.due_date END,
    received_at         = coalesce((v_f ->> 'received_at')::timestamptz, si.received_at),
    currency            = coalesce(v_f ->> 'currency', si.currency),
    subtotal = v_amt[1], vat_amount = v_amt[2], total_amount = v_amt[3],
    reference           = CASE WHEN v_f ? 'reference' THEN v_f ->> 'reference' ELSE si.reference END,
    supplier_vat_number = CASE WHEN v_f ? 'supplier_vat_number' THEN v_f ->> 'supplier_vat_number' ELSE si.supplier_vat_number END,
    finance_document_id = CASE WHEN v_f ? 'finance_document_id' THEN (v_f ->> 'finance_document_id')::uuid ELSE si.finance_document_id END,
    source_document_id  = CASE WHEN v_f ? 'source_document_id' THEN (v_f ->> 'source_document_id')::uuid ELSE si.source_document_id END,
    notes               = CASE WHEN v_f ? 'notes' THEN v_f ->> 'notes' ELSE si.notes END
   WHERE si.id = v_si.id RETURNING * INTO v_new;
  -- the payment status follows a total change
  PERFORM app.fin_payment_recompute(v_new.id);
  SELECT * INTO v_new FROM public.supplier_invoices si WHERE si.id = v_si.id;
  SELECT jsonb_agg(k ORDER BY k) INTO v_changed FROM jsonb_object_keys(v_f) k
   WHERE (to_jsonb(v_new) -> k) IS DISTINCT FROM (to_jsonb(v_si) -> k);
  RETURN to_jsonb(v_new) || jsonb_build_object('changed', coalesce(v_changed, '[]'::jsonb),
    'discrepancy', app.fin_invoice_discrepancy(v_new.id),
    'possible_duplicates', app.fin_possible_duplicates(v_new.org_id, v_new.supplier_id, v_new.number_norm, v_new.invoice_date,
                                                       v_new.total_amount, app.fin_invoice_sha(v_new), v_new.id));
END $$;

-- invoice void (status RPC and duplicate approval): no payment, no approved allocation; proposed ones are rejected
CREATE OR REPLACE FUNCTION app.fin_void_invoice(p_si public.supplier_invoices, p_reason text, p_dup_of uuid) RETURNS public.supplier_invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.supplier_invoices; r record;
BEGIN
  IF p_si.status = 'void' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'void'); END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_payments sp WHERE sp.supplier_invoice_id = p_si.id AND sp.status = 'recorded') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'has_payments');
  END IF;
  IF EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.supplier_invoice_id = p_si.id AND a.status = 'approved') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'has_approved_allocations');
  END IF;
  FOR r IN UPDATE public.cost_allocations a SET status = 'rejected', decided_by = auth.uid(), decided_at = now(),
                  decision_note = 'invoice_void'
            WHERE a.supplier_invoice_id = p_si.id AND a.status = 'proposed' RETURNING a.id, a.org_id, a.transaction_id LOOP
    PERFORM app.fin_event(r.org_id, r.transaction_id, 'allocation_rejected', 'cost_allocation', r.id, 'proposed', 'rejected',
                          jsonb_build_object('supplier_invoice_id', p_si.id));
  END LOOP;
  UPDATE public.supplier_invoices si SET status = 'void', void_reason = p_reason, status_note = p_reason,
         duplicate_of_id = coalesce(p_dup_of, si.duplicate_of_id), approved_by = NULL, approved_at = NULL
   WHERE si.id = p_si.id RETURNING * INTO v;
  -- an approved credit note no longer reduces what is owed on its original
  IF v.doc_type = 'credit_note' AND v.adjusts_invoice_id IS NOT NULL THEN
    PERFORM 1 FROM public.supplier_invoices o WHERE o.id = v.adjusts_invoice_id FOR UPDATE;
    PERFORM app.fin_payment_recompute(v.adjusts_invoice_id);
  END IF;
  RETURN v;
END $$;

-- set_supplier_invoice_status(p_id, under_review|approved|disputed|void|received, p_note)
--   received → under_review | disputed | void;  under_review → approved | disputed | void;
--   disputed → under_review | void;  approved → disputed (note).  void / approved → fin_approve; void needs a note.
CREATE OR REPLACE FUNCTION public.set_supplier_invoice_status(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_si public.supplier_invoices; v_from text; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_disc jsonb; v_bad text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_si := app.fin_lock_invoice(p_id, app.fin_write_roles());
  IF p_status IS NULL OR p_status NOT IN ('received','under_review','approved','disputed','void') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_si.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT ((v_si.status = 'received' AND p_status IN ('under_review','disputed','void'))
       OR (v_si.status = 'under_review' AND p_status IN ('approved','disputed','void'))
       OR (v_si.status = 'disputed' AND p_status IN ('under_review','void'))
       OR (v_si.status = 'approved' AND p_status = 'disputed')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', v_si.status);
  END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF p_status IN ('approved','void') AND NOT app.has_branch_role(v_si.org_id, v_si.branch_id, app.fin_approve_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  v_from := v_si.status;
  IF p_status = 'void' THEN
    IF v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
    v_si := app.fin_void_invoice(v_si, v_note, NULL);
    RETURN to_jsonb(v_si) || jsonb_build_object('from', v_from);
  END IF;
  IF v_from = 'approved' AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF p_status = 'approved' THEN
    PERFORM app.fin_four_eyes(v_si.org_id, v_si.created_by);
    IF v_si.finance_document_id IS NULL AND v_si.source_document_id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'original_file'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = v_si.id) THEN
      PERFORM app.fail('MRS_REQUIRED', 'lines');
    END IF;
    SELECT string_agg(l.line_no::text, ',' ORDER BY l.line_no) INTO v_bad FROM public.supplier_invoice_lines l
     WHERE l.supplier_invoice_id = v_si.id AND l.review_status IN ('pending_review','disputed');
    IF v_bad IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'lines_pending_review', v_bad); END IF;
    SELECT string_agg(l.line_no::text, ',' ORDER BY l.line_no) INTO v_bad FROM public.supplier_invoice_lines l
     WHERE l.supplier_invoice_id = v_si.id AND l.review_status = 'ok'
       AND l.net_amount <> coalesce((SELECT sum(a.amount) FROM public.cost_allocations a WHERE a.line_id = l.id AND a.status = 'approved'), 0);
    IF v_bad IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'lines_unallocated', v_bad); END IF;
    v_disc := app.fin_invoice_discrepancy(v_si.id);
    IF ((v_disc ->> 'net')::numeric <> 0 OR (v_disc ->> 'vat')::numeric <> 0 OR (v_disc ->> 'total')::numeric <> 0) AND v_note IS NULL THEN
      PERFORM app.fail('MRS_NOTE_REQUIRED', 'discrepancy');
    END IF;
  END IF;
  UPDATE public.supplier_invoices si SET
    status = p_status,
    status_note = coalesce(v_note, si.status_note),
    approved_by = CASE WHEN p_status = 'approved' THEN auth.uid() END,
    approved_at = CASE WHEN p_status = 'approved' THEN now() END,
    discrepancy_note = CASE WHEN p_status = 'approved' AND ((v_disc ->> 'net')::numeric <> 0 OR (v_disc ->> 'vat')::numeric <> 0
                                                            OR (v_disc ->> 'total')::numeric <> 0)
                            THEN v_note ELSE si.discrepancy_note END
   WHERE si.id = v_si.id RETURNING * INTO v_si;
  -- a credit note entering / leaving 'approved' changes what is owed on its original (locked: lock order note → original)
  IF v_si.doc_type = 'credit_note' AND (p_status = 'approved' OR v_from = 'approved') THEN
    PERFORM app.fin_check_credit_cap(v_si.adjusts_invoice_id, v_si.id, v_si.doc_type, v_si.total_amount, v_si.currency::text);
    PERFORM app.fin_payment_recompute(v_si.adjusts_invoice_id);
  END IF;
  RETURN to_jsonb(v_si) || jsonb_build_object('from', v_from);
END $$;

-- check_supplier_invoice_duplicate(p_org, {supplier_id, invoice_number, invoice_date?, total_amount?, doc_type?, sha256?})
CREATE OR REPLACE FUNCTION public.check_supplier_invoice_duplicate(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_sup uuid; v_no text; v_norm text; v_date date; v_tot numeric; v_doc text; v_sha text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(p_payload, ARRAY['supplier_id','invoice_number','invoice_date','total_amount','doc_type','sha256']);
  v_sup := app.puuid(p_payload, 'supplier_id');
  v_no := app.ptext(p_payload, 'invoice_number', 60);
  v_norm := nullif(app.fin_norm_no(v_no), '');
  v_date := app.pdate(p_payload, 'invoice_date');
  v_tot := app.fin_money(p_payload, 'total_amount');
  v_doc := coalesce(app.ptext(p_payload, 'doc_type', 20), 'invoice');
  IF v_doc NOT IN ('invoice','credit_note','debit_note') THEN PERFORM app.fail('MRS_INVALID', 'doc_type'); END IF;
  v_sha := lower(app.ptext(p_payload, 'sha256', 64));
  IF v_sha IS NOT NULL AND v_sha !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', 'sha256'); END IF;
  RETURN jsonb_build_object(
    'number_norm', v_norm,
    'exact', coalesce((SELECT jsonb_agg(jsonb_build_object('id', si.id, 'invoice_number', si.invoice_number, 'status', si.status,
                         'invoice_date', si.invoice_date, 'readable', app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()))
                         ORDER BY si.invoice_date, si.id)
                         FROM public.supplier_invoices si
                        WHERE si.org_id = p_org AND si.supplier_id = v_sup AND si.doc_type = v_doc AND si.number_norm = v_norm
                          AND si.status <> 'void'), '[]'::jsonb),
    'possible', CASE WHEN v_sup IS NULL THEN '[]'::jsonb
                     ELSE (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(
                             app.fin_possible_duplicates(p_org, v_sup, v_norm, v_date, v_tot, NULL, NULL)) x
                            WHERE NOT (x ->> 'id')::uuid IN (SELECT si.id FROM public.supplier_invoices si
                                       WHERE si.org_id = p_org AND si.supplier_id = v_sup AND si.doc_type = v_doc
                                         AND si.number_norm = v_norm AND si.status <> 'void')) END,
    'file', CASE WHEN v_sha IS NULL THEN '[]'::jsonb ELSE coalesce((
              SELECT jsonb_agg(jsonb_build_object('finance_document_id', f.id, 'original_name', f.original_name,
                       'uploaded_at', f.uploaded_at,
                       'invoices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', si.id, 'invoice_number', si.invoice_number,
                                              'status', si.status) ORDER BY si.created_at)
                                               FROM public.supplier_invoices si WHERE si.finance_document_id = f.id), '[]'::jsonb))
                       ORDER BY f.uploaded_at)
                FROM public.finance_documents f
               WHERE f.org_id = p_org AND f.sha256 = v_sha AND f.voided_at IS NULL
                 AND app.has_branch_role(f.org_id, f.branch_id, app.fin_read_roles())), '[]'::jsonb) END);
END $$;

-- add_invoice_lines(p_invoice, p_lines[], p_source manual|ocr|import, p_idem_key) — ≤ 200 lines
CREATE OR REPLACE FUNCTION public.add_invoice_lines(p_invoice uuid, p_lines jsonb, p_source text DEFAULT 'manual', p_idem_key uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_si public.supplier_invoices; v_replay jsonb; v_lines jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_si := app.fin_lock_invoice(p_invoice, app.fin_write_roles());
  v_replay := app.idem_begin('add_invoice_lines', p_idem_key,
    jsonb_build_object('invoice', p_invoice, 'lines', p_lines, 'source', coalesce(p_source, 'manual')), v_si.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_lines := app.fin_insert_lines(v_si, p_lines, coalesce(p_source, 'manual'));
  RETURN app.idem_finish('add_invoice_lines', p_idem_key,
    jsonb_build_object('invoice_id', v_si.id, 'lines', v_lines, 'discrepancy', app.fin_invoice_discrepancy(v_si.id)));
END $$;

-- lock a line + its invoice (lock order: invoice → line)
CREATE OR REPLACE FUNCTION app.fin_lock_line(p_line uuid, p_roles text[], OUT o_si public.supplier_invoices, OUT o_line public.supplier_invoice_lines)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_si uuid;
BEGIN
  SELECT l.supplier_invoice_id INTO v_si FROM public.supplier_invoice_lines l WHERE l.id = p_line;
  IF v_si IS NULL OR NOT app.fin_can_read_invoice(v_si) THEN PERFORM app.fail('MRS_NOT_FOUND', 'line'); END IF;
  o_si := app.fin_lock_invoice(v_si, p_roles);
  SELECT * INTO o_line FROM public.supplier_invoice_lines l WHERE l.id = p_line FOR UPDATE;
END $$;

-- update_invoice_line(p_id, {description?, quantity?, unit?, unit_price?, net_amount?, vat_rate?, vat_amount?, total_amount?,
--   service_code?, container_no_hint?, reference_hint?}) — refused while the line carries a live allocation
CREATE OR REPLACE FUNCTION public.update_invoice_line(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_si public.supplier_invoices; v_l public.supplier_invoice_lines; v_f jsonb; r record;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT x.o_si, x.o_line INTO r FROM app.fin_lock_line(p_id, app.fin_write_roles()) x;
  v_si := r.o_si; v_l := r.o_line;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR p_payload = '{}'::jsonb OR p_payload ? 'line_no' THEN
    PERFORM app.fail(CASE WHEN p_payload ? 'line_no' THEN 'MRS_INVALID' ELSE 'MRS_REQUIRED' END, 'payload');
  END IF;
  PERFORM app.fin_invoice_editable(v_si);
  IF EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.line_id = v_l.id AND a.status IN ('proposed','approved')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'allocated');
  END IF;
  v_f := app.fin_line_fields(p_payload, true, v_l);
  UPDATE public.supplier_invoice_lines l SET
    description = v_f ->> 'description', quantity = (v_f ->> 'quantity')::numeric, unit = v_f ->> 'unit',
    unit_price = (v_f ->> 'unit_price')::numeric, net_amount = (v_f ->> 'net_amount')::numeric,
    vat_rate = (v_f ->> 'vat_rate')::numeric, vat_amount = (v_f ->> 'vat_amount')::numeric,
    service_code = v_f ->> 'service_code', container_no_hint = v_f ->> 'container_no_hint', reference_hint = v_f ->> 'reference_hint'
   WHERE l.id = v_l.id RETURNING * INTO v_l;
  RETURN to_jsonb(v_l) || jsonb_build_object('discrepancy', app.fin_invoice_discrepancy(v_si.id));
END $$;

-- review_invoice_line(p_id, ok|overhead|excluded|disputed, p_note (required except ok), p_service_code?)
CREATE OR REPLACE FUNCTION public.review_invoice_line(p_id uuid, p_decision text, p_note text DEFAULT NULL, p_service_code text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_si public.supplier_invoices; v_l public.supplier_invoice_lines; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_svc text := nullif(btrim(coalesce(p_service_code, '')), ''); v_from text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT x.o_si, x.o_line INTO r FROM app.fin_lock_line(p_id, app.fin_write_roles()) x;
  v_si := r.o_si; v_l := r.o_line;
  IF p_decision IS NULL OR p_decision NOT IN ('ok','overhead','excluded','disputed') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  IF p_decision <> 'ok' AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  PERFORM app.fin_check_service(v_svc);
  PERFORM app.fin_invoice_editable(v_si);
  IF p_decision <> 'ok' AND EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.line_id = v_l.id AND a.status IN ('proposed','approved')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'allocated');
  END IF;
  v_from := v_l.review_status;
  UPDATE public.supplier_invoice_lines l SET review_status = p_decision, review_note = coalesce(v_note, l.review_note),
         service_code = coalesce(v_svc, l.service_code), reviewed_by = auth.uid(), reviewed_at = now()
   WHERE l.id = v_l.id RETURNING * INTO v_l;
  RETURN to_jsonb(v_l) || jsonb_build_object('from', v_from);
END $$;

-- ---------------------------------------------------------------------
-- 6. accruals — matching + sync (trips, demurrage cases)
-- ---------------------------------------------------------------------
-- recompute an accrual from its approved allocations. p_cause 'reversal' names a partial result allocation_reversed.
--   m = 0          → open (a waiting new cost becomes the amount) — or void when its trip / case is gone
--   source gone    → variance (trip_cancelled_after_match / amount_diff), variance_amount = m
--   pending amount → variance (reason kept), variance_amount = m − pending
--   m = amount     → matched
--   otherwise      → variance amount_diff | allocation_reversed, variance_amount = m − amount
CREATE OR REPLACE FUNCTION app.fin_rematch_accrual(p_id uuid, p_cause text DEFAULT 'match', p_events boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a public.cost_accruals; m numeric; v_gone boolean; v_status text; v_reason text; v_var numeric; v_amount numeric;
  v_pending numeric; v_void text;
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;
  SELECT * INTO a FROM public.cost_accruals x WHERE x.id = p_id FOR UPDATE;
  IF a.id IS NULL THEN RETURN; END IF;
  SELECT coalesce(sum(x.amount), 0) INTO m FROM public.cost_allocations x WHERE x.accrual_id = a.id AND x.status = 'approved';
  IF a.status = 'void' THEN
    IF a.matched_amount <> m THEN UPDATE public.cost_accruals x SET matched_amount = m WHERE x.id = a.id; END IF;
    RETURN;
  END IF;
  v_gone := (a.source = 'trip' AND EXISTS (SELECT 1 FROM public.transport_trips t WHERE t.id = a.trip_id AND t.status = 'cancelled'))
         OR (a.source = 'demurrage' AND EXISTS (SELECT 1 FROM public.demurrage_cases c WHERE c.id = a.demurrage_case_id
                                                  AND (c.status IN ('waived','void') OR c.estimated_amount IS NULL)));
  v_amount := a.amount; v_pending := a.pending_amount; v_reason := a.variance_reason; v_var := a.variance_amount;
  IF m = 0 THEN
    IF v_gone THEN
      v_status := 'void'; v_void := CASE WHEN a.source = 'trip' THEN 'trip_cancelled' ELSE 'source_closed' END;
    ELSE
      v_status := 'open'; v_reason := NULL; v_var := NULL;
      IF v_pending IS NOT NULL THEN v_amount := v_pending; v_pending := NULL; END IF;
    END IF;
  ELSIF v_gone THEN
    v_status := 'variance'; v_reason := CASE WHEN a.source = 'trip' THEN 'trip_cancelled_after_match' ELSE 'amount_diff' END; v_var := m;
  ELSIF v_pending IS NOT NULL THEN
    v_status := 'variance'; v_reason := coalesce(a.variance_reason, 'amount_diff'); v_var := m - v_pending;
  ELSIF v_amount IS NOT NULL AND m = v_amount THEN
    v_status := 'matched'; v_reason := NULL; v_var := NULL;
  ELSE
    v_status := 'variance'; v_reason := CASE WHEN p_cause = 'reversal' THEN 'allocation_reversed' ELSE 'amount_diff' END;
    v_var := m - coalesce(v_amount, 0);
  END IF;
  IF (a.matched_amount, a.status, a.variance_reason, a.variance_amount, a.amount, a.pending_amount)
     IS DISTINCT FROM (m, v_status, v_reason, v_var, v_amount, v_pending) THEN
    UPDATE public.cost_accruals x SET matched_amount = m, status = v_status, variance_reason = v_reason, variance_amount = v_var,
           amount = v_amount, pending_amount = v_pending, void_reason = coalesce(v_void, x.void_reason)
     WHERE x.id = a.id;
    IF p_events AND v_status IS DISTINCT FROM a.status THEN
      PERFORM app.fin_event(a.org_id, a.transaction_id, 'accrual_' || v_status, 'cost_accrual', a.id, a.status, v_status,
                            jsonb_strip_nulls(jsonb_build_object('trip_id', a.trip_id, 'demurrage_case_id', a.demurrage_case_id)));
    END IF;
  END IF;
END $$;

-- one accrual per non-cancelled trip (trigger on transport_trips; no events: the trip RPC logs its own, audit_log keeps the values). Amounts change in place while unmatched;
-- after a match the counted cost stays the invoice allocation: a new trip cost waits in pending_amount (variance).
CREATE OR REPLACE FUNCTION app.sync_trip_accrual(t public.transport_trips) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.cost_accruals; v_basis text := CASE WHEN t.cost_basis = 'agreed' THEN 'agreed' ELSE 'estimated' END;
BEGIN
  SELECT * INTO a FROM public.cost_accruals x WHERE x.trip_id = t.id AND x.status <> 'void' FOR UPDATE;
  IF a.id IS NULL THEN
    -- never re-created over a voided one (cancel / manual void)
    IF t.status = 'cancelled' OR EXISTS (SELECT 1 FROM public.cost_accruals x WHERE x.trip_id = t.id) THEN RETURN; END IF;
    INSERT INTO public.cost_accruals (org_id, transaction_id, container_id, source, trip_id, supplier_id, service_code,
                                      amount, currency, basis, created_by)
    VALUES (t.org_id, t.transaction_id, t.container_id, 'trip', t.id, t.carrier_id, 'transport',
            t.cost_amount, t.cost_currency, v_basis, auth.uid());
    RETURN;
  END IF;
  IF t.status = 'cancelled' THEN
    PERFORM app.fin_rematch_accrual(a.id, 'match', false);
    RETURN;
  END IF;
  IF a.matched_amount = 0 AND a.status = 'open' THEN
    IF (a.amount, a.currency::text, a.supplier_id, a.basis, a.container_id)
       IS DISTINCT FROM (t.cost_amount, t.cost_currency, t.carrier_id, v_basis, t.container_id) THEN
      UPDATE public.cost_accruals x SET amount = t.cost_amount, currency = t.cost_currency, supplier_id = t.carrier_id,
             basis = v_basis, container_id = t.container_id
       WHERE x.id = a.id;
    END IF;
    RETURN;
  END IF;
  IF (a.supplier_id, a.container_id, a.basis) IS DISTINCT FROM (t.carrier_id, t.container_id, v_basis) THEN
    UPDATE public.cost_accruals x SET supplier_id = t.carrier_id, container_id = t.container_id, basis = v_basis WHERE x.id = a.id;
  END IF;
  IF t.cost_amount IS DISTINCT FROM a.amount OR t.cost_currency IS DISTINCT FROM a.currency::text THEN
    IF a.pending_amount IS DISTINCT FROM t.cost_amount OR a.status <> 'variance' THEN
      UPDATE public.cost_accruals x SET pending_amount = t.cost_amount, status = 'variance',
             variance_reason = 'trip_cost_changed_after_match', variance_amount = a.matched_amount - coalesce(t.cost_amount, 0)
       WHERE x.id = a.id;
    END IF;
  ELSIF a.pending_amount IS NOT NULL THEN
    -- the trip cost went back to the matched amount
    UPDATE public.cost_accruals x SET pending_amount = NULL WHERE x.id = a.id;
    PERFORM app.fin_rematch_accrual(a.id, 'match', false);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.tg_trip_accrual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.sync_trip_accrual(NEW);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g4_accrual ON public.transport_trips;
CREATE TRIGGER trg_g4_accrual AFTER INSERT OR UPDATE OF cost_amount, cost_currency, cost_basis, carrier_id, container_id, status
  ON public.transport_trips FOR EACH ROW EXECUTE FUNCTION app.tg_trip_accrual();

CREATE OR REPLACE FUNCTION app.fin_case_service(p_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'storage' THEN 'storage' WHEN 'demurrage' THEN 'demurrage' ELSE 'detention' END
$$;

-- demurrage estimate → source='demurrage' accrual (same rules as trips)
CREATE OR REPLACE FUNCTION app.sync_demurrage_accrual(c public.demurrage_cases) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.cost_accruals; v_active boolean := c.status IN ('open','closed') AND c.estimated_amount IS NOT NULL;
BEGIN
  SELECT * INTO a FROM public.cost_accruals x WHERE x.demurrage_case_id = c.id AND x.status <> 'void' FOR UPDATE;
  IF a.id IS NULL THEN
    IF NOT v_active THEN RETURN; END IF;
    INSERT INTO public.cost_accruals (org_id, transaction_id, container_id, source, demurrage_case_id, supplier_id, service_code,
                                      amount, currency, basis, created_by)
    VALUES (c.org_id, c.transaction_id, c.container_id, 'demurrage', c.id, c.operator_id, app.fin_case_service(c.kind),
            c.estimated_amount, c.currency, 'estimated', auth.uid());
    RETURN;
  END IF;
  IF NOT v_active THEN
    PERFORM app.fin_rematch_accrual(a.id, 'match', false);
    RETURN;
  END IF;
  IF a.matched_amount = 0 AND a.status = 'open' THEN
    IF (a.amount, a.currency, a.supplier_id, a.container_id, a.service_code)
       IS DISTINCT FROM (c.estimated_amount, c.currency, c.operator_id, c.container_id, app.fin_case_service(c.kind)) THEN
      UPDATE public.cost_accruals x SET amount = c.estimated_amount, currency = c.currency, supplier_id = c.operator_id,
             container_id = c.container_id, service_code = app.fin_case_service(c.kind)
       WHERE x.id = a.id;
    END IF;
    RETURN;
  END IF;
  IF (a.supplier_id, a.container_id) IS DISTINCT FROM (c.operator_id, c.container_id) THEN
    UPDATE public.cost_accruals x SET supplier_id = c.operator_id, container_id = c.container_id WHERE x.id = a.id;
  END IF;
  IF c.estimated_amount IS DISTINCT FROM a.amount OR c.currency IS DISTINCT FROM a.currency THEN
    IF a.pending_amount IS DISTINCT FROM c.estimated_amount OR a.status <> 'variance' THEN
      UPDATE public.cost_accruals x SET pending_amount = c.estimated_amount, status = 'variance', variance_reason = 'amount_diff',
             variance_amount = a.matched_amount - c.estimated_amount
       WHERE x.id = a.id;
    END IF;
  ELSIF a.pending_amount IS NOT NULL THEN
    UPDATE public.cost_accruals x SET pending_amount = NULL WHERE x.id = a.id;
    PERFORM app.fin_rematch_accrual(a.id, 'match', false);
  ELSIF a.status = 'variance' AND a.variance_reason = 'amount_diff' AND a.matched_amount = a.amount THEN
    PERFORM app.fin_rematch_accrual(a.id, 'match', false);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.tg_demurrage_accrual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.sync_demurrage_accrual(NEW);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_g4_accrual ON public.demurrage_cases;
CREATE TRIGGER trg_g4_accrual AFTER INSERT OR UPDATE OF estimated_amount, currency, operator_id, container_id, status, kind
  ON public.demurrage_cases FOR EACH ROW EXECUTE FUNCTION app.tg_demurrage_accrual();

-- backfill: one accrual per existing non-cancelled trip (no events; re-runs add nothing). The audit trigger is attached
-- first, so each backfilled expected cost has its INSERT row in audit_log (actor NULL = migration); the generic block
-- below re-creates it idempotently.
DROP TRIGGER IF EXISTS trg_audit ON public.cost_accruals;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.cost_accruals FOR EACH ROW EXECUTE FUNCTION app.tg_audit();
INSERT INTO public.cost_accruals (org_id, transaction_id, container_id, source, trip_id, supplier_id, service_code, amount, currency, basis)
SELECT t.org_id, t.transaction_id, t.container_id, 'trip', t.id, t.carrier_id, 'transport', t.cost_amount, t.cost_currency,
       CASE WHEN t.cost_basis = 'agreed' THEN 'agreed' ELSE 'estimated' END
  FROM public.transport_trips t
 WHERE t.status <> 'cancelled'
   AND NOT EXISTS (SELECT 1 FROM public.cost_accruals x WHERE x.trip_id = t.id)
 ORDER BY t.created_at, t.id
ON CONFLICT (trip_id) WHERE status <> 'void' DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. allocations — cap + guard
-- ---------------------------------------------------------------------
-- Σ live (proposed + approved) allocations of a line never exceeds its net; only 'ok' lines take new allocations
CREATE OR REPLACE FUNCTION app.tg_alloc_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.supplier_invoice_lines; v_others numeric;
BEGIN
  IF NEW.status NOT IN ('proposed','approved') THEN RETURN NEW; END IF;
  SELECT * INTO l FROM public.supplier_invoice_lines x WHERE x.id = NEW.line_id FOR UPDATE;
  IF l.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'line_id'); END IF;
  IF TG_OP = 'INSERT' AND l.review_status <> 'ok' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'line_' || l.review_status); END IF;
  SELECT coalesce(sum(a.amount), 0) INTO v_others FROM public.cost_allocations a
   WHERE a.line_id = NEW.line_id AND a.status IN ('proposed','approved') AND a.id <> NEW.id;
  IF v_others + NEW.amount > l.net_amount THEN
    PERFORM app.fail('MRS_OVER_ALLOCATED', greatest(l.net_amount - v_others, 0)::text);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_alloc_cap ON public.cost_allocations;
CREATE TRIGGER trg_alloc_cap BEFORE INSERT OR UPDATE OF amount, status ON public.cost_allocations
  FOR EACH ROW EXECUTE FUNCTION app.tg_alloc_cap();

-- approved rows are immutable (a correction is reverse_allocation); decided rows never come back
CREATE OR REPLACE FUNCTION app.tg_alloc_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','decided_by','decided_at','decision_note','reversed_by','reversed_at','reverse_reason','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','decided_by','decided_at','decision_note','reversed_by','reversed_at','reverse_reason','updated_at']) THEN
    PERFORM app.fail('MRS_IMMUTABLE', 'cost_allocation');
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'proposed' AND NEW.status IN ('approved','rejected'))
                                                  OR (OLD.status = 'approved' AND NEW.status = 'reversed')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', OLD.status);
  END IF;
  IF NEW.status = OLD.status AND OLD.status <> 'proposed'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    PERFORM app.fail('MRS_IMMUTABLE', 'cost_allocation');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard ON public.cost_allocations;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.cost_allocations FOR EACH ROW EXECUTE FUNCTION app.tg_alloc_guard();

-- live accrual of a trip / demurrage case (NULL when none)
CREATE OR REPLACE FUNCTION app.fin_live_accrual(p_trip uuid, p_case uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id FROM public.cost_accruals x
   WHERE x.status <> 'void' AND ((p_trip IS NOT NULL AND x.trip_id = p_trip) OR (p_trip IS NULL AND p_case IS NOT NULL AND x.demurrage_case_id = p_case))
   LIMIT 1
$$;

-- ---------------------------------------------------------------------
-- 5. allocation RPCs
-- ---------------------------------------------------------------------
-- allocate_invoice_line(p_line, [{transaction_id, container_id?, trip_id?, demurrage_case_id?, accrual_id?,
--   amount? | share_pct?, service_code?, note?}], p_idem_key) — all targets by amount, or all by share (Σ ≤ 100 %,
--   largest remainder: 100 % = exactly the line net). A trip / case without accrual_id is matched to its live accrual.
CREATE OR REPLACE FUNCTION public.allocate_invoice_line(p_line uuid, p_targets jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_siid uuid; v_org uuid; v_si public.supplier_invoices; v_l public.supplier_invoice_lines; v_replay jsonb;
  e jsonb; v_ord bigint; v_txid uuid; v_tx public.transactions; v_mode text; v_n_amt int; v_n_pct int; v_pcts numeric[];
  v_sum_pct numeric; v_cents numeric[]; v_rem numeric; v_total_cents numeric; v_amount numeric; v_pct numeric;
  v_ct uuid; v_trip uuid; v_case uuid; v_acc uuid; v_acc_cur text; v_svc text; v_note text; v_a public.cost_allocations;
  v_rows jsonb := '[]'::jsonb; v_live numeric; v_noacc boolean; v_auto boolean; v_cand_n int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT l.supplier_invoice_id, l.org_id INTO v_siid, v_org FROM public.supplier_invoice_lines l WHERE l.id = p_line;
  IF v_siid IS NULL OR NOT app.fin_can_read_invoice(v_siid) THEN PERFORM app.fail('MRS_NOT_FOUND', 'line'); END IF;
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN
    PERFORM app.fail('MRS_REQUIRED', 'targets');
  END IF;
  IF jsonb_array_length(p_targets) > 50 THEN PERFORM app.fail('MRS_TOO_LONG', 'targets'); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_targets) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'targets'); END IF;
    PERFORM app.only_keys(e, ARRAY['transaction_id','container_id','trip_id','demurrage_case_id','accrual_id','amount','share_pct',
                                   'service_code','note','no_accrual']);
    IF app.puuid(e, 'transaction_id') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  END LOOP;
  -- lock order: transactions (sorted) → invoice → line
  FOR v_txid IN SELECT DISTINCT (x ->> 'transaction_id')::uuid FROM jsonb_array_elements(p_targets) x ORDER BY 1 LOOP
    v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles());
    IF v_tx.org_id <> v_org THEN PERFORM app.fail('MRS_INVALID', 'transaction_id'); END IF;
  END LOOP;
  v_si := app.fin_lock_invoice(v_siid, app.fin_write_roles());
  SELECT * INTO v_l FROM public.supplier_invoice_lines l WHERE l.id = p_line FOR UPDATE;
  v_replay := app.idem_begin('allocate_invoice_line', p_idem_key, jsonb_build_object('line', p_line, 'targets', p_targets), v_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.fin_invoice_editable(v_si);
  IF v_l.review_status <> 'ok' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'line_' || v_l.review_status); END IF;

  SELECT count(*) FILTER (WHERE x ? 'amount' AND x ->> 'amount' IS NOT NULL),
         count(*) FILTER (WHERE x ? 'share_pct' AND x ->> 'share_pct' IS NOT NULL)
    INTO v_n_amt, v_n_pct FROM jsonb_array_elements(p_targets) x;
  IF v_n_amt = jsonb_array_length(p_targets) AND v_n_pct = 0 THEN v_mode := 'amount';
  ELSIF v_n_pct = jsonb_array_length(p_targets) AND v_n_amt = 0 THEN v_mode := 'share';
  ELSE PERFORM app.fail('MRS_INVALID', 'targets'); END IF;
  IF v_mode = 'share' THEN
    SELECT array_agg(app.pnum(x, 'share_pct', 100) ORDER BY o) INTO v_pcts FROM jsonb_array_elements(p_targets) WITH ORDINALITY y(x, o);
    IF EXISTS (SELECT 1 FROM unnest(v_pcts) p WHERE p <= 0 OR p <> round(p, 4)) THEN PERFORM app.fail('MRS_INVALID', 'share_pct'); END IF;
    SELECT sum(p) INTO v_sum_pct FROM unnest(v_pcts) p;
    IF v_sum_pct > 100 THEN PERFORM app.fail('MRS_INVALID', 'share_pct'); END IF;
    -- largest remainder over cents
    v_total_cents := round(v_l.net_amount * 100 * v_sum_pct / 100);
    SELECT v_total_cents - sum(floor(v_l.net_amount * 100 * p / 100)) INTO v_rem FROM unnest(v_pcts) p;
    SELECT array_agg(c ORDER BY o) INTO v_cents FROM (
      SELECT b.o, b.fl + CASE WHEN b.rn <= v_rem THEN 1 ELSE 0 END AS c FROM (
        SELECT a.o, a.fl, row_number() OVER (ORDER BY a.fr DESC, a.o) AS rn FROM (
          SELECT u.o, floor(v_l.net_amount * 100 * u.p / 100) AS fl,
                 v_l.net_amount * 100 * u.p / 100 - floor(v_l.net_amount * 100 * u.p / 100) AS fr
            FROM unnest(v_pcts) WITH ORDINALITY u(p, o)) a) b) c;
  END IF;

  FOR e, v_ord IN SELECT x, o FROM jsonb_array_elements(p_targets) WITH ORDINALITY y(x, o) LOOP
    v_txid := app.puuid(e, 'transaction_id');
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_txid;
    v_ct := app.puuid(e, 'container_id');
    PERFORM app.g3_check_container(v_tx.id, v_ct);
    v_trip := app.puuid(e, 'trip_id');
    IF v_trip IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transport_trips t WHERE t.id = v_trip AND t.transaction_id = v_tx.id) THEN
      PERFORM app.fail('MRS_INVALID', 'trip_id');
    END IF;
    v_case := app.puuid(e, 'demurrage_case_id');
    IF v_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.demurrage_cases c WHERE c.id = v_case AND c.transaction_id = v_tx.id) THEN
      PERFORM app.fail('MRS_INVALID', 'demurrage_case_id');
    END IF;
    v_acc := app.puuid(e, 'accrual_id');
    IF v_acc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cost_accruals x WHERE x.id = v_acc AND x.transaction_id = v_tx.id
                                                                             AND x.status <> 'void') THEN
      PERFORM app.fail('MRS_INVALID', 'accrual_id');
    END IF;
    v_svc := coalesce(app.ptext(e, 'service_code', 40), v_l.service_code);
    PERFORM app.fin_check_service(v_svc);
    v_noacc := coalesce(app.pbool(e, 'no_accrual'), false);
    v_auto := false;
    IF v_noacc AND (v_acc IS NOT NULL OR v_trip IS NOT NULL OR v_case IS NOT NULL) THEN PERFORM app.fail('MRS_INVALID', 'no_accrual'); END IF;
    IF v_si.doc_type = 'credit_note' THEN
      -- a credit note is not the matching document of a trip / case / expected cost: it only reduces transaction cost
      IF v_acc IS NOT NULL OR v_trip IS NOT NULL OR v_case IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'credit_note_link'); END IF;
    ELSE
      IF v_acc IS NULL AND (v_trip IS NOT NULL OR v_case IS NOT NULL) THEN v_acc := app.fin_live_accrual(v_trip, v_case); END IF;
      -- no trip / case / accrual named: the one open expected cost of the same supplier + currency (+ service) on that
      -- transaction is matched, so the invoice and the accrual are never both counted; several → the user picks
      -- (accrual_id) or states 'no_accrual': true
      IF v_acc IS NULL AND v_trip IS NULL AND v_case IS NULL AND NOT v_noacc THEN
        SELECT count(*)::int, (array_agg(x.id ORDER BY x.created_at, x.id))[1] INTO v_cand_n, v_acc
          FROM public.cost_accruals x
         WHERE x.transaction_id = v_tx.id AND x.status = 'open' AND x.supplier_id = v_si.supplier_id
           AND x.currency = v_si.currency AND (x.amount IS NULL OR x.amount > x.matched_amount)
           AND (x.service_code IS NULL OR v_svc IS NULL OR x.service_code = v_svc);
        IF v_cand_n > 1 THEN
          PERFORM app.fin_fail('MRS_REQUIRED', 'accrual_id',
            (SELECT string_agg(x.id::text, ',' ORDER BY x.created_at, x.id) FROM public.cost_accruals x
              WHERE x.transaction_id = v_tx.id AND x.status = 'open' AND x.supplier_id = v_si.supplier_id
                AND x.currency = v_si.currency AND (x.amount IS NULL OR x.amount > x.matched_amount)
                AND (x.service_code IS NULL OR v_svc IS NULL OR x.service_code = v_svc)));
        END IF;
        IF v_acc IS NOT NULL THEN
          v_auto := true;
          SELECT x.trip_id, x.demurrage_case_id, coalesce(v_ct, x.container_id) INTO v_trip, v_case, v_ct
            FROM public.cost_accruals x WHERE x.id = v_acc;
        END IF;
      END IF;
      -- the matched source is in the invoice currency (also with no live accrual)
      IF v_case IS NOT NULL AND (SELECT c.currency::text FROM public.demurrage_cases c WHERE c.id = v_case) IS DISTINCT FROM v_si.currency::text THEN
        PERFORM app.fail('MRS_INVALID', 'currency');
      END IF;
      IF v_trip IS NOT NULL AND (SELECT t.cost_currency::text FROM public.transport_trips t WHERE t.id = v_trip) IS DISTINCT FROM v_si.currency::text THEN
        PERFORM app.fail('MRS_INVALID', 'currency');
      END IF;
    END IF;
    IF v_acc IS NOT NULL THEN
      SELECT x.currency INTO v_acc_cur FROM public.cost_accruals x WHERE x.id = v_acc;
      IF v_acc_cur IS DISTINCT FROM v_si.currency::text THEN PERFORM app.fail('MRS_INVALID', 'currency'); END IF;
    END IF;
    v_note := app.ptext(e, 'note', 2000);
    IF v_mode = 'share' THEN
      v_pct := v_pcts[v_ord]; v_amount := v_cents[v_ord] / 100;
      IF v_amount <= 0 THEN PERFORM app.fail('MRS_INVALID', 'share_pct'); END IF;
    ELSE
      v_pct := NULL; v_amount := app.fin_money(e, 'amount');
      IF v_amount IS NULL OR v_amount <= 0 THEN PERFORM app.fail('MRS_INVALID', 'amount'); END IF;
    END IF;
    PERFORM app.fin_check_credit_target(v_si, v_tx.id, v_amount, NULL, true);
    INSERT INTO public.cost_allocations (org_id, supplier_invoice_id, line_id, transaction_id, container_id, trip_id, demurrage_case_id,
      accrual_id, amount, share_pct, service_code, is_late, note, created_by)
    VALUES (v_org, v_si.id, v_l.id, v_tx.id, v_ct, v_trip, v_case, v_acc, v_amount, v_pct, v_svc,
            v_tx.operational_status IN ('under_billing','billed','closed'), v_note, auth.uid())
    RETURNING * INTO v_a;
    PERFORM app.fin_event(v_org, v_tx.id, 'allocation_proposed', 'cost_allocation', v_a.id, NULL, 'proposed',
      jsonb_strip_nulls(jsonb_build_object('supplier_invoice_id', v_si.id, 'line_id', v_l.id, 'trip_id', v_trip,
                                           'demurrage_case_id', v_case, 'accrual_id', v_acc, 'container_id', v_ct)));
    v_rows := v_rows || jsonb_build_array(to_jsonb(v_a) || jsonb_build_object('auto_accrual', v_auto));
  END LOOP;
  SELECT coalesce(sum(a.amount), 0) INTO v_live FROM public.cost_allocations a WHERE a.line_id = v_l.id AND a.status IN ('proposed','approved');
  RETURN app.idem_finish('allocate_invoice_line', p_idem_key,
    jsonb_build_object('line_id', v_l.id, 'net_amount', v_l.net_amount, 'allocations', v_rows, 'remaining', v_l.net_amount - v_live));
END $$;

-- lock the transactions (sorted) of a set of allocations with p_roles; invisible → MRS_NOT_FOUND
CREATE OR REPLACE FUNCTION app.fin_lock_alloc_txs(p_ids uuid[], p_roles text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(p_ids) i WHERE NOT EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.id = i))
     OR EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.id = ANY (p_ids)
                 AND NOT app.has_tx_role(a.transaction_id, app.fin_read_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'allocation');
  END IF;
  FOR v_tx IN SELECT DISTINCT a.transaction_id FROM public.cost_allocations a WHERE a.id = ANY (p_ids) ORDER BY 1 LOOP
    PERFORM app.g3_lock_tx(v_tx, p_roles);
  END LOOP;
  PERFORM 1 FROM public.supplier_invoices si
   WHERE si.id IN (SELECT a.supplier_invoice_id FROM public.cost_allocations a WHERE a.id = ANY (p_ids)) ORDER BY si.id FOR UPDATE;
  PERFORM 1 FROM public.supplier_invoice_lines l
   WHERE l.id IN (SELECT a.line_id FROM public.cost_allocations a WHERE a.id = ANY (p_ids)) ORDER BY l.id FOR UPDATE;
END $$;

-- approve_allocations(p_ids ≤ 100, p_note) — fin_approve at each transaction's branch, four eyes; late rows need the note
-- and each one adds an approved late_cost adjustment. Matching with the linked accruals happens here.
CREATE OR REPLACE FUNCTION public.approve_allocations(p_ids uuid[], p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ids uuid[]; v_note text := nullif(btrim(coalesce(p_note, '')), ''); a public.cost_allocations; v_si public.supplier_invoices;
  v_adj public.cost_adjustments; v_out jsonb := '[]'::jsonb; v_acc uuid; v_accs uuid[] := '{}';
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT array_agg(DISTINCT i ORDER BY i) INTO v_ids FROM unnest(p_ids) i WHERE i IS NOT NULL;
  IF v_ids IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'ids'); END IF;
  IF cardinality(v_ids) > 100 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  PERFORM app.fin_lock_alloc_txs(v_ids, app.fin_approve_roles());
  FOR a IN SELECT * FROM public.cost_allocations x WHERE x.id = ANY (v_ids) ORDER BY x.transaction_id, x.id FOR UPDATE LOOP
    IF a.status <> 'proposed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', a.status); END IF;
    PERFORM app.fin_four_eyes(a.org_id, a.created_by);
    SELECT * INTO v_si FROM public.supplier_invoices si WHERE si.id = a.supplier_invoice_id;
    IF v_si.status = 'void' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'invoice_void'); END IF;
    IF a.is_late AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'late_cost'); END IF;
    -- the linked expected cost may have changed currency since the proposal (trip / case edited in place)
    IF a.accrual_id IS NOT NULL AND (SELECT x.currency::text FROM public.cost_accruals x WHERE x.id = a.accrual_id)
                                    IS DISTINCT FROM v_si.currency::text THEN
      PERFORM app.fail('MRS_INVALID', 'currency');
    END IF;
    -- the adjusted invoice's allocations may have been reversed since the proposal
    PERFORM app.fin_check_credit_target(v_si, a.transaction_id, a.amount, a.id, false);
    UPDATE public.cost_allocations x SET status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
     WHERE x.id = a.id RETURNING * INTO a;
    PERFORM app.fin_event(a.org_id, a.transaction_id, 'allocation_approved', 'cost_allocation', a.id, 'proposed', 'approved',
      jsonb_strip_nulls(jsonb_build_object('supplier_invoice_id', a.supplier_invoice_id, 'line_id', a.line_id, 'accrual_id', a.accrual_id)));
    IF a.is_late THEN
      INSERT INTO public.cost_adjustments (org_id, kind, transaction_id, container_id, supplier_invoice_id, supplier_id, service_code,
        amount, currency, finance_document_id, document_id, reason, status, reviewed_by, reviewed_at, review_note, created_by)
      VALUES (a.org_id, 'late_cost', a.transaction_id, a.container_id, a.supplier_invoice_id, v_si.supplier_id, a.service_code,
        a.amount, v_si.currency, v_si.finance_document_id, v_si.source_document_id, v_note, 'approved', auth.uid(), now(), v_note, auth.uid())
      RETURNING * INTO v_adj;
      PERFORM app.fin_event(a.org_id, a.transaction_id, 'late_cost', 'cost_adjustment', v_adj.id, NULL, 'approved',
        jsonb_build_object('cost_allocation_id', a.id, 'supplier_invoice_id', a.supplier_invoice_id));
    END IF;
    IF a.accrual_id IS NOT NULL AND NOT (a.accrual_id = ANY (v_accs)) THEN v_accs := v_accs || a.accrual_id; END IF;
    v_out := v_out || jsonb_build_array(to_jsonb(a) || jsonb_build_object('late_adjustment_id', v_adj.id));
    v_adj := NULL;
  END LOOP;
  FOREACH v_acc IN ARRAY v_accs LOOP PERFORM app.fin_rematch_accrual(v_acc, 'match'); END LOOP;
  RETURN jsonb_build_object('items', v_out, 'count', jsonb_array_length(v_out));
END $$;

-- reject_allocation(p_id, p_reason) — proposed only
CREATE OR REPLACE FUNCTION public.reject_allocation(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.cost_allocations; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_lock_alloc_txs(ARRAY[p_id], app.fin_approve_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  SELECT * INTO a FROM public.cost_allocations x WHERE x.id = p_id FOR UPDATE;
  IF a.status <> 'proposed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', a.status); END IF;
  UPDATE public.cost_allocations x SET status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = v_reason
   WHERE x.id = a.id RETURNING * INTO a;
  PERFORM app.fin_event(a.org_id, a.transaction_id, 'allocation_rejected', 'cost_allocation', a.id, 'proposed', 'rejected',
    jsonb_build_object('supplier_invoice_id', a.supplier_invoice_id, 'line_id', a.line_id));
  RETURN to_jsonb(a) || jsonb_build_object('from', 'proposed');
END $$;

-- reverse_allocation(p_id, p_reason) — approved only, while the invoice is not approved (dispute it first)
CREATE OR REPLACE FUNCTION public.reverse_allocation(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.cost_allocations; v_reason text; v_st text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_lock_alloc_txs(ARRAY[p_id], app.fin_approve_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  SELECT * INTO a FROM public.cost_allocations x WHERE x.id = p_id FOR UPDATE;
  IF a.status <> 'approved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', a.status); END IF;
  SELECT si.status INTO v_st FROM public.supplier_invoices si WHERE si.id = a.supplier_invoice_id;
  IF v_st = 'approved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'invoice_approved'); END IF;
  -- a cost already billed to the client must be un-charged first (void the charge)
  IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.cost_allocation_id = a.id AND c.status <> 'void') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'charged_to_client');
  END IF;
  -- credit notes already reducing this transaction's share of the invoice keep it ≥ 0
  IF (SELECT coalesce(sum(x.amount), 0) FROM public.cost_allocations x JOIN public.supplier_invoices cn ON cn.id = x.supplier_invoice_id
       WHERE cn.adjusts_invoice_id = a.supplier_invoice_id AND cn.doc_type = 'credit_note' AND cn.status <> 'void'
         AND x.transaction_id = a.transaction_id AND x.status IN ('proposed','approved'))
     > (SELECT coalesce(sum(x.amount), 0) FROM public.cost_allocations x
         WHERE x.supplier_invoice_id = a.supplier_invoice_id AND x.transaction_id = a.transaction_id AND x.status = 'approved' AND x.id <> a.id) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'credit_allocated');
  END IF;
  UPDATE public.cost_allocations x SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reverse_reason = v_reason
   WHERE x.id = a.id RETURNING * INTO a;
  PERFORM app.fin_event(a.org_id, a.transaction_id, 'allocation_reversed', 'cost_allocation', a.id, 'approved', 'reversed',
    jsonb_strip_nulls(jsonb_build_object('supplier_invoice_id', a.supplier_invoice_id, 'line_id', a.line_id, 'accrual_id', a.accrual_id)));
  PERFORM app.fin_rematch_accrual(a.accrual_id, 'reversal');
  RETURN to_jsonb(a) || jsonb_build_object('from', 'approved');
END $$;

-- ---------------------------------------------------------------------
-- 6. accrual RPCs
-- ---------------------------------------------------------------------
-- create_accrual({transaction_id, container_id?, supplier_id?, service_code?, amount?, currency?, basis?}, p_idem_key) — manual
CREATE OR REPLACE FUNCTION public.create_accrual(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_txid uuid; v_replay jsonb; v_a public.cost_accruals; v_sup uuid; v_svc text; v_basis text; v_ct uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','container_id','supplier_id','service_code','amount','currency','basis','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles());
  v_replay := app.idem_begin('create_accrual', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_ct := app.puuid(p_payload, 'container_id');
  PERFORM app.g3_check_container(v_tx.id, v_ct);
  v_sup := app.puuid(p_payload, 'supplier_id');
  IF v_sup IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id = v_sup AND pa.org_id = v_tx.org_id AND pa.is_active) THEN
    PERFORM app.fail('MRS_INVALID', 'supplier_id');
  END IF;
  v_svc := app.ptext(p_payload, 'service_code', 40);
  PERFORM app.fin_check_service(v_svc);
  v_basis := coalesce(app.ptext(p_payload, 'basis', 20), 'estimated');
  IF v_basis NOT IN ('agreed','estimated') THEN PERFORM app.fail('MRS_INVALID', 'basis'); END IF;
  INSERT INTO public.cost_accruals (org_id, transaction_id, container_id, source, supplier_id, service_code, amount, currency, basis, created_by)
  VALUES (v_tx.org_id, v_tx.id, v_ct, 'manual', v_sup, v_svc, app.fin_money(p_payload, 'amount'),
          coalesce(app.fin_currency(p_payload, 'currency'), 'SAR'), v_basis, auth.uid())
  RETURNING * INTO v_a;
  PERFORM app.fin_event(v_a.org_id, v_a.transaction_id, 'accrual_created', 'cost_accrual', v_a.id, NULL, 'open');
  RETURN app.idem_finish('create_accrual', p_idem_key, to_jsonb(v_a));
END $$;

-- review_accrual_variance(p_id, accept|keep_open|accept_new_amount|keep_amount, p_note)
CREATE OR REPLACE FUNCTION public.review_accrual_variance(p_id uuid, p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.cost_accruals; v_note text; v_from text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO a FROM public.cost_accruals x WHERE x.id = p_id;
  IF a.id IS NULL OR NOT app.has_tx_role(a.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'accrual'); END IF;
  PERFORM app.g3_lock_tx(a.transaction_id, app.fin_approve_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('accept','keep_open','accept_new_amount','keep_amount') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.fin_note(p_note, 'note');
  SELECT * INTO a FROM public.cost_accruals x WHERE x.id = p_id FOR UPDATE;
  IF a.status <> 'variance' THEN PERFORM app.fail('MRS_BAD_TRANSITION', a.status); END IF;
  IF p_decision = 'keep_open' AND a.pending_amount IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'pending_amount'); END IF;
  IF p_decision = 'accept_new_amount' AND a.pending_amount IS NULL THEN PERFORM app.fail('MRS_INVALID', 'pending_amount'); END IF;
  v_from := a.status;
  UPDATE public.cost_accruals x SET reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note,
    status = CASE p_decision WHEN 'accept' THEN 'matched' WHEN 'keep_open' THEN 'open' ELSE x.status END,
    pending_amount = CASE WHEN p_decision IN ('accept','keep_amount','accept_new_amount') THEN NULL ELSE x.pending_amount END,
    amount = CASE WHEN p_decision = 'accept_new_amount' THEN x.pending_amount ELSE x.amount END
   WHERE x.id = a.id;
  IF p_decision IN ('accept_new_amount','keep_amount') THEN PERFORM app.fin_rematch_accrual(a.id, 'match'); END IF;
  SELECT * INTO a FROM public.cost_accruals x WHERE x.id = p_id;
  PERFORM app.fin_event(a.org_id, a.transaction_id, 'accrual_reviewed', 'cost_accrual', a.id, v_from, a.status,
                        jsonb_build_object('decision', p_decision));
  RETURN to_jsonb(a) || jsonb_build_object('from', v_from, 'decision', p_decision);
END $$;

-- void_accrual(p_id, p_reason) — open and unmatched only
CREATE OR REPLACE FUNCTION public.void_accrual(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.cost_accruals; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO a FROM public.cost_accruals x WHERE x.id = p_id;
  IF a.id IS NULL OR NOT app.has_tx_role(a.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'accrual'); END IF;
  PERFORM app.g3_lock_tx(a.transaction_id, app.fin_write_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  SELECT * INTO a FROM public.cost_accruals x WHERE x.id = p_id FOR UPDATE;
  IF a.status <> 'open' OR a.matched_amount <> 0
     OR EXISTS (SELECT 1 FROM public.cost_allocations x WHERE x.accrual_id = a.id AND x.status IN ('proposed','approved')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', CASE WHEN a.status <> 'open' THEN a.status ELSE 'matched' END);
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.accrual_id = a.id AND c.status <> 'void') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'charged_to_client');
  END IF;
  UPDATE public.cost_accruals x SET status = 'void', void_reason = v_reason WHERE x.id = a.id RETURNING * INTO a;
  PERFORM app.fin_event(a.org_id, a.transaction_id, 'accrual_voided', 'cost_accrual', a.id, 'open', 'void');
  RETURN to_jsonb(a) || jsonb_build_object('from', 'open');
END $$;

-- ---------------------------------------------------------------------
-- 7. supplier payments (append-only evidence; cache on the invoice)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fin_payment_recompute(p_si uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_co numeric; v_cl numeric; v_tot numeric; v_st text;
BEGIN
  SELECT coalesce(sum(sp.amount) FILTER (WHERE sp.payer = 'company'), 0), coalesce(sum(sp.amount) FILTER (WHERE sp.payer = 'client'), 0)
    INTO v_co, v_cl FROM public.supplier_payments sp WHERE sp.supplier_invoice_id = p_si AND sp.status = 'recorded';
  v_tot := app.fin_invoice_payable(p_si);       -- total − approved credit notes against it
  v_st := CASE WHEN v_co + v_cl = 0 THEN 'unpaid'
               WHEN v_cl >= v_tot AND v_co = 0 THEN 'paid_directly_by_client'
               WHEN v_co + v_cl >= v_tot THEN 'paid'
               ELSE 'partial' END;
  UPDATE public.supplier_invoices si SET company_paid_amount = v_co, client_paid_amount = v_cl, payment_status = v_st
   WHERE si.id = p_si AND (si.company_paid_amount, si.client_paid_amount, si.payment_status) IS DISTINCT FROM (v_co, v_cl, v_st);
END $$;

-- BEFORE INSERT: checks (currency, void / credit note, overpay, client-direct vs charged reimbursable).
-- BEFORE UPDATE: recorded → void only (append-only). AFTER: invoice cache.
CREATE OR REPLACE FUNCTION app.tg_payment_totals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_si public.supplier_invoices; v_paid numeric; v_cl_gross numeric; v_cl_paid numeric;
BEGIN
  IF TG_WHEN = 'AFTER' THEN
    PERFORM app.fin_payment_recompute(NEW.supplier_invoice_id);
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status','void_reason','voided_by','voided_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','void_reason','voided_by','voided_at'])
       OR NOT (OLD.status = 'recorded' AND NEW.status = 'void') THEN
      PERFORM app.fail('MRS_APPEND_ONLY', TG_TABLE_NAME);
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoices si WHERE si.id = NEW.supplier_invoice_id FOR UPDATE;
  IF v_si.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'supplier_invoice_id'); END IF;
  IF v_si.status = 'void' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'void'); END IF;
  IF v_si.doc_type = 'credit_note' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'credit_note'); END IF;
  NEW.currency := v_si.currency;
  NEW.status := 'recorded'; NEW.void_reason := NULL; NEW.voided_by := NULL; NEW.voided_at := NULL;
  SELECT coalesce(sum(sp.amount), 0) INTO v_paid FROM public.supplier_payments sp
   WHERE sp.supplier_invoice_id = v_si.id AND sp.status = 'recorded';
  -- payable = total − approved credit notes against it
  IF v_paid + NEW.amount > app.fin_invoice_payable(v_si.id) THEN
    PERFORM app.fail('MRS_OVERPAID', greatest(app.fin_invoice_payable(v_si.id) - v_paid, 0)::text);
  END IF;
  IF NEW.payer = 'client' THEN
    -- a client-direct payment settles THAT client's share: it must have a live allocation on the invoice,
    -- and its direct payments never exceed the gross of its live allocations
    SELECT coalesce(sum(CASE WHEN l.net_amount > 0 THEN a.amount * l.total_amount / l.net_amount ELSE a.amount END), 0) INTO v_cl_gross
      FROM public.cost_allocations a JOIN public.supplier_invoice_lines l ON l.id = a.line_id
      JOIN public.transactions t ON t.id = a.transaction_id
     WHERE a.supplier_invoice_id = v_si.id AND a.status IN ('proposed','approved') AND t.client_id = NEW.client_id;
    IF v_cl_gross <= 0 THEN PERFORM app.fail('MRS_INVALID', 'client_id'); END IF;
    SELECT coalesce(sum(sp.amount), 0) INTO v_cl_paid FROM public.supplier_payments sp
     WHERE sp.supplier_invoice_id = v_si.id AND sp.status = 'recorded' AND sp.payer = 'client' AND sp.client_id = NEW.client_id;
    IF v_cl_paid + NEW.amount > round(v_cl_gross, 2) THEN
      PERFORM app.fail('MRS_OVERPAID', greatest(round(v_cl_gross, 2) - v_cl_paid, 0)::text);
    END IF;
  END IF;
  -- the client cannot pay twice: a cost of ITS transactions already charged to it (any sourced charge) must be un-charged first
  IF NEW.payer = 'client' AND EXISTS (
       SELECT 1 FROM public.client_charges c
        WHERE c.status <> 'void' AND c.source IN ('from_cost','markup')
          AND (c.cost_allocation_id IN (SELECT a.id FROM public.cost_allocations a JOIN public.transactions t ON t.id = a.transaction_id
                                         WHERE a.supplier_invoice_id = v_si.id AND a.status IN ('proposed','approved')
                                           AND t.client_id = NEW.client_id)
               OR c.accrual_id IN (SELECT a.accrual_id FROM public.cost_allocations a JOIN public.transactions t ON t.id = a.transaction_id
                                    WHERE a.supplier_invoice_id = v_si.id AND a.status IN ('proposed','approved') AND a.accrual_id IS NOT NULL
                                      AND t.client_id = NEW.client_id))) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'charged_to_client');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payment_check ON public.supplier_payments;
CREATE TRIGGER trg_payment_check BEFORE INSERT OR UPDATE ON public.supplier_payments FOR EACH ROW EXECUTE FUNCTION app.tg_payment_totals();
DROP TRIGGER IF EXISTS trg_payment_totals ON public.supplier_payments;
CREATE TRIGGER trg_payment_totals AFTER INSERT OR UPDATE ON public.supplier_payments FOR EACH ROW EXECUTE FUNCTION app.tg_payment_totals();

-- record_supplier_payment({supplier_invoice_id, amount, paid_at, method, payer?, client_id?, reference?, evidence_document_id?}, p_idem_key)
-- Evidence only: never creates a charge, collection, accrual or allocation.
CREATE OR REPLACE FUNCTION public.record_supplier_payment(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_si public.supplier_invoices; v_siid uuid; v_replay jsonb; v_amount numeric; v_at date; v_method text; v_payer text;
  v_client uuid; v_ev uuid; v_ref text; v_p public.supplier_payments;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['supplier_invoice_id','amount','paid_at','method','payer','client_id','reference',
                                         'evidence_document_id','idempotencyKey']);
  v_siid := app.puuid(p_payload, 'supplier_invoice_id');
  IF v_siid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'supplier_invoice_id'); END IF;
  v_si := app.fin_lock_invoice(v_siid, app.fin_write_roles());
  v_replay := app.idem_begin('record_supplier_payment', p_idem_key, p_payload - 'idempotencyKey', v_si.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_amount := app.fin_money(p_payload, 'amount');
  IF v_amount IS NULL OR v_amount <= 0 THEN PERFORM app.fail('MRS_INVALID', 'amount'); END IF;
  v_at := coalesce(app.pdate(p_payload, 'paid_at'), current_date);
  IF v_at > current_date + 1 THEN PERFORM app.fail('MRS_INVALID', 'paid_at'); END IF;
  v_method := app.ptext(p_payload, 'method', 20, true);
  IF NOT app.is_code('fin_payment_method', v_method) THEN PERFORM app.fail('MRS_INVALID', 'method'); END IF;
  v_payer := coalesce(app.ptext(p_payload, 'payer', 20), 'company');
  IF v_payer NOT IN ('company','client') THEN PERFORM app.fail('MRS_INVALID', 'payer'); END IF;
  v_client := app.puuid(p_payload, 'client_id');
  IF v_payer = 'client' AND v_client IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client_id'); END IF;
  IF v_payer = 'company' AND v_client IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'client_id'); END IF;
  IF v_client IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client AND c.org_id = v_si.org_id) THEN
    PERFORM app.fail('MRS_INVALID', 'client_id');
  END IF;
  v_ev := app.puuid(p_payload, 'evidence_document_id');
  PERFORM app.fin_check_findoc(v_si.org_id, v_si.branch_id, v_ev, 'evidence_document_id');
  v_ref := app.ptext(p_payload, 'reference', 120);
  IF v_ref IS NULL AND v_ev IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'reference_or_evidence'); END IF;
  IF v_payer = 'client' AND v_ev IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'evidence_document_id'); END IF;
  INSERT INTO public.supplier_payments (org_id, supplier_invoice_id, amount, currency, paid_at, method, payer, client_id, reference,
                                        evidence_document_id, created_by)
  VALUES (v_si.org_id, v_si.id, v_amount, v_si.currency, v_at, v_method, v_payer, v_client, v_ref, v_ev, auth.uid())
  RETURNING * INTO v_p;
  SELECT * INTO v_si FROM public.supplier_invoices si WHERE si.id = v_si.id;
  RETURN app.idem_finish('record_supplier_payment', p_idem_key, to_jsonb(v_p) || jsonb_build_object(
    'invoice', jsonb_build_object('id', v_si.id, 'payment_status', v_si.payment_status, 'company_paid_amount', v_si.company_paid_amount,
                                  'client_paid_amount', v_si.client_paid_amount, 'total_amount', v_si.total_amount)));
END $$;

-- void_supplier_payment(p_id, p_reason) — fin_approve; the invoice cache is recomputed
CREATE OR REPLACE FUNCTION public.void_supplier_payment(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_p public.supplier_payments; v_si public.supplier_invoices; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_p FROM public.supplier_payments sp WHERE sp.id = p_id;
  IF v_p.id IS NULL OR NOT app.fin_can_read_invoice(v_p.supplier_invoice_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'payment'); END IF;
  v_si := app.fin_lock_invoice(v_p.supplier_invoice_id, app.fin_approve_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  SELECT * INTO v_p FROM public.supplier_payments sp WHERE sp.id = p_id FOR UPDATE;
  IF v_p.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_p.status); END IF;
  UPDATE public.supplier_payments sp SET status = 'void', void_reason = v_reason, voided_by = auth.uid(), voided_at = now()
   WHERE sp.id = v_p.id RETURNING * INTO v_p;
  SELECT * INTO v_si FROM public.supplier_invoices si WHERE si.id = v_si.id;
  RETURN to_jsonb(v_p) || jsonb_build_object('from', 'recorded', 'invoice', jsonb_build_object('id', v_si.id,
    'payment_status', v_si.payment_status, 'company_paid_amount', v_si.company_paid_amount, 'client_paid_amount', v_si.client_paid_amount));
END $$;

-- ---------------------------------------------------------------------
-- 8. client charges (sell side)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_client_charges_price() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.net_amount := round(NEW.quantity * NEW.unit_price, 2);
  NEW.vat_amount := round(NEW.net_amount * NEW.vat_rate / 100, 2);
  NEW.total_amount := NEW.net_amount + NEW.vat_amount;
  NEW.description := btrim(NEW.description);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_price ON public.client_charges;
CREATE TRIGGER trg_price BEFORE INSERT OR UPDATE ON public.client_charges FOR EACH ROW EXECUTE FUNCTION app.tg_client_charges_price();

-- the allocation's OWN client already paid (directly) the supplier invoice behind an allocation / accrual
CREATE OR REPLACE FUNCTION app.fin_cost_paid_by_client(p_alloc uuid, p_accrual uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.cost_allocations a JOIN public.transactions t ON t.id = a.transaction_id
                  WHERE a.status IN ('proposed','approved')
                    AND ((p_alloc IS NOT NULL AND a.id = p_alloc) OR (p_accrual IS NOT NULL AND a.accrual_id = p_accrual))
                    AND EXISTS (SELECT 1 FROM public.supplier_payments sp
                                 WHERE sp.supplier_invoice_id = a.supplier_invoice_id AND sp.status = 'recorded'
                                   AND sp.payer = 'client' AND sp.client_id = t.client_id))
$$;

-- current cost behind a sourced charge (for "cost changed since priced")
CREATE OR REPLACE FUNCTION app.fin_charge_cost(c public.client_charges) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN c.cost_allocation_id IS NOT NULL
              THEN (SELECT CASE WHEN a.status IN ('proposed','approved') THEN a.amount ELSE 0 END FROM public.cost_allocations a WHERE a.id = c.cost_allocation_id)
              WHEN c.accrual_id IS NOT NULL
              THEN (SELECT CASE WHEN x.status = 'void' THEN 0 ELSE x.amount END FROM public.cost_accruals x WHERE x.id = c.accrual_id) END
$$;

CREATE OR REPLACE FUNCTION app.fin_charge_json(c public.client_charges) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
    'branch_id', (SELECT t.branch_id FROM public.transactions t WHERE t.id = c.transaction_id),
    'collected_amount', coalesce((SELECT sum(k.amount) FROM public.charge_collections k WHERE k.charge_id = c.id AND k.status = 'recorded'), 0),
    'current_cost', app.fin_charge_cost(c),
    'cost_changed', c.cost_snapshot IS NOT NULL AND app.fin_charge_cost(c) IS DISTINCT FROM c.cost_snapshot)
$$;

-- create_client_charge({transaction_id, kind, description, quantity?, unit_price?, vat_rate?, currency?, service_code?, container_id?,
--   source? manual|from_cost|markup|from_trip, cost_allocation_id?, accrual_id?, trip_id?, demurrage_case_id?, markup_pct?, note?}, p_idem_key)
CREATE OR REPLACE FUNCTION public.create_client_charge(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions; v_txid uuid; v_replay jsonb; v_kind text; v_src text; v_desc text; v_qty numeric; v_up numeric;
  v_rate numeric; v_cur text; v_svc text; v_ct uuid; v_alloc uuid; v_acc uuid; v_trip uuid; v_case uuid; v_pct numeric;
  v_cost numeric; v_cost_cur text; v_c public.client_charges; r record; v_link_acc uuid; v_src_trip uuid; v_case_cur text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','container_id','kind','service_code','description','quantity','unit_price',
    'vat_rate','currency','source','cost_allocation_id','accrual_id','trip_id','demurrage_case_id','markup_pct','note','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles());
  v_replay := app.idem_begin('create_client_charge', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_kind := app.ptext(p_payload, 'kind', 20, true);
  IF v_kind NOT IN ('service','internal_service','reimbursable') THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_src := coalesce(app.ptext(p_payload, 'source', 20), 'manual');
  IF v_src NOT IN ('manual','from_cost','markup','from_trip') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
  v_desc := app.ptext(p_payload, 'description', 300, true);
  v_ct := app.puuid(p_payload, 'container_id');
  PERFORM app.g3_check_container(v_tx.id, v_ct);
  v_svc := app.ptext(p_payload, 'service_code', 40);
  PERFORM app.fin_check_service(v_svc);
  v_rate := app.pnum(p_payload, 'vat_rate', 100);
  IF v_rate IS NULL THEN v_rate := CASE WHEN v_kind = 'reimbursable' THEN 0 ELSE 15 END; END IF;
  v_cur := app.fin_currency(p_payload, 'currency');
  v_alloc := app.puuid(p_payload, 'cost_allocation_id');
  v_acc := app.puuid(p_payload, 'accrual_id');
  v_trip := app.puuid(p_payload, 'trip_id');
  v_case := app.puuid(p_payload, 'demurrage_case_id');
  IF v_trip IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transport_trips t WHERE t.id = v_trip AND t.transaction_id = v_tx.id) THEN
    PERFORM app.fail('MRS_INVALID', 'trip_id');
  END IF;
  IF v_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.demurrage_cases c WHERE c.id = v_case AND c.transaction_id = v_tx.id) THEN
    PERFORM app.fail('MRS_INVALID', 'demurrage_case_id');
  END IF;
  v_qty := coalesce(app.pnum(p_payload, 'quantity', 99999999999), 1);
  IF v_qty <= 0 OR v_qty <> round(v_qty, 3) THEN PERFORM app.fail('MRS_INVALID', 'quantity'); END IF;
  v_up := app.fin_money(p_payload, 'unit_price');

  IF v_src IN ('from_cost','markup') THEN
    IF num_nonnulls(v_alloc, v_acc) <> 1 THEN PERFORM app.fail('MRS_INVALID', 'cost_link'); END IF;
    IF p_payload ? 'unit_price' OR p_payload ? 'quantity' THEN PERFORM app.fail('MRS_INVALID', 'unit_price'); END IF;
    IF v_alloc IS NOT NULL THEN
      SELECT a.amount, si.currency, a.demurrage_case_id, a.trip_id, a.container_id, a.accrual_id INTO r
        FROM public.cost_allocations a JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id
       WHERE a.id = v_alloc AND a.transaction_id = v_tx.id AND a.status IN ('proposed','approved') AND si.status <> 'void';
      IF r IS NULL OR r.amount IS NULL THEN PERFORM app.fail('MRS_INVALID', 'cost_allocation_id'); END IF;
      v_cost := r.amount; v_cost_cur := r.currency;
      v_case := coalesce(v_case, r.demurrage_case_id); v_ct := coalesce(v_ct, r.container_id);
      v_link_acc := r.accrual_id;
      v_src_trip := coalesce(r.trip_id, (SELECT x.trip_id FROM public.cost_accruals x WHERE x.id = r.accrual_id));
    ELSE
      SELECT x.amount, x.currency, x.demurrage_case_id, x.container_id, x.trip_id INTO r FROM public.cost_accruals x
       WHERE x.id = v_acc AND x.transaction_id = v_tx.id AND x.status <> 'void';
      IF r IS NULL THEN PERFORM app.fail('MRS_INVALID', 'accrual_id'); END IF;
      IF r.amount IS NULL THEN PERFORM app.fail('MRS_INVALID', 'cost_unknown'); END IF;
      v_cost := r.amount; v_cost_cur := r.currency;
      v_case := coalesce(v_case, r.demurrage_case_id); v_ct := coalesce(v_ct, r.container_id);
      v_link_acc := v_acc; v_src_trip := r.trip_id;
    END IF;
    IF v_cur IS NOT NULL AND v_cur <> v_cost_cur THEN PERFORM app.fail('MRS_INVALID', 'currency'); END IF;
    v_cur := v_cost_cur; v_qty := 1;
    IF v_src = 'markup' THEN
      v_pct := app.pnum(p_payload, 'markup_pct', 1000);
      IF v_pct IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'markup_pct'); END IF;
      v_up := round(v_cost * (1 + v_pct / 100), 2);
    ELSE
      IF p_payload ? 'markup_pct' THEN PERFORM app.fail('MRS_INVALID', 'markup_pct'); END IF;
      v_up := v_cost;
    END IF;
    -- any sourced charge (reimbursable, service or markup) on a cost the client already paid the supplier for would bill it twice;
    -- a genuine handling fee is a manual (internal_)service charge
    IF app.fin_cost_paid_by_client(v_alloc, v_acc) THEN PERFORM app.fail('MRS_INVALID', 'paid_by_client'); END IF;
    -- one charge per cost — also across the allocation ↔ accrual link (the transaction lock serialises this check):
    --   an allocation whose accrual already carries a charge, an accrual one of whose allocations carries a charge
    IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status <> 'void'
                 AND ((v_alloc IS NOT NULL AND c.cost_allocation_id = v_alloc) OR (v_acc IS NOT NULL AND c.accrual_id = v_acc)
                      OR (v_alloc IS NOT NULL AND v_link_acc IS NOT NULL AND c.accrual_id = v_link_acc)
                      OR (v_acc IS NOT NULL AND c.cost_allocation_id IN (SELECT a.id FROM public.cost_allocations a
                                                                          WHERE a.accrual_id = v_acc AND a.status IN ('proposed','approved'))))) THEN
      PERFORM app.fail('MRS_INVALID', 'cost_charged');
    END IF;
    -- the trip leg is already billed from its sell price
    IF v_src_trip IS NOT NULL AND EXISTS (SELECT 1 FROM public.client_charges c WHERE c.trip_id = v_src_trip AND c.status <> 'void') THEN
      PERFORM app.fail('MRS_INVALID', 'trip_charged');
    END IF;
  ELSE
    IF v_alloc IS NOT NULL OR v_acc IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'cost_link'); END IF;
    IF p_payload ? 'markup_pct' THEN PERFORM app.fail('MRS_INVALID', 'markup_pct'); END IF;
    IF v_src = 'from_trip' THEN
      IF v_trip IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'trip_id'); END IF;
      IF p_payload ? 'unit_price' OR p_payload ? 'quantity' THEN PERFORM app.fail('MRS_INVALID', 'unit_price'); END IF;
      SELECT t.sell_amount, t.sell_currency, t.container_id, t.status INTO r FROM public.transport_trips t WHERE t.id = v_trip;
      IF r.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'trip_cancelled'); END IF;
      IF r.sell_amount IS NULL THEN PERFORM app.fail('MRS_INVALID', 'sell_amount'); END IF;
      -- the leg is already billed through its cost (a charge on the trip's accrual or on an allocation of the trip)
      IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status <> 'void'
                   AND (c.accrual_id IN (SELECT x.id FROM public.cost_accruals x WHERE x.trip_id = v_trip)
                        OR c.cost_allocation_id IN (SELECT a.id FROM public.cost_allocations a
                                                     WHERE a.status IN ('proposed','approved')
                                                       AND (a.trip_id = v_trip OR a.accrual_id IN (SELECT x.id FROM public.cost_accruals x WHERE x.trip_id = v_trip))))) THEN
        PERFORM app.fail('MRS_INVALID', 'trip_charged');
      END IF;
      IF v_cur IS NOT NULL AND v_cur <> r.sell_currency THEN PERFORM app.fail('MRS_INVALID', 'currency'); END IF;
      v_up := r.sell_amount; v_cur := r.sell_currency; v_qty := 1; v_ct := coalesce(v_ct, r.container_id);
    END IF;
    IF v_up IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'unit_price'); END IF;
  END IF;
  IF v_trip IS NOT NULL AND EXISTS (SELECT 1 FROM public.client_charges c WHERE c.trip_id = v_trip AND c.status <> 'void') THEN
    PERFORM app.fail('MRS_INVALID', 'trip_charged');
  END IF;
  -- a charge on a storage / demurrage case is in the case currency (its four figures are per currency)
  IF v_case IS NOT NULL THEN
    SELECT c.currency::text INTO v_case_cur FROM public.demurrage_cases c WHERE c.id = v_case;
    IF v_cur IS NULL THEN v_cur := v_case_cur; ELSIF v_cur <> v_case_cur THEN PERFORM app.fail('MRS_INVALID', 'currency'); END IF;
  END IF;
  INSERT INTO public.client_charges (org_id, transaction_id, container_id, kind, service_code, description, quantity, unit_price, vat_rate,
    currency, source, cost_allocation_id, accrual_id, trip_id, demurrage_case_id, markup_pct, cost_snapshot, note, created_by)
  VALUES (v_tx.org_id, v_tx.id, v_ct, v_kind, v_svc, v_desc, v_qty, v_up, v_rate, coalesce(v_cur, 'SAR'), v_src, v_alloc, v_acc,
    v_trip, v_case, v_pct, CASE WHEN v_src IN ('from_cost','markup') THEN v_cost END, app.ptext(p_payload, 'note', 2000), auth.uid())
  RETURNING * INTO v_c;
  PERFORM app.fin_event(v_c.org_id, v_c.transaction_id, 'charge_created', 'client_charge', v_c.id, NULL, 'draft',
    jsonb_strip_nulls(jsonb_build_object('kind', v_c.kind, 'source', v_c.source, 'cost_allocation_id', v_alloc, 'accrual_id', v_acc,
                                         'trip_id', v_trip, 'demurrage_case_id', v_case)));
  RETURN app.idem_finish('create_client_charge', p_idem_key, app.fin_charge_json(v_c));
END $$;

-- update_client_charge(p_id, {description?, vat_rate?, service_code?, container_id?, note?, quantity?, unit_price? (manual only),
--   markup_pct? (markup only)}) — draft only
CREATE OR REPLACE FUNCTION public.update_client_charge(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.client_charges; v_tx public.transactions; v_svc text; v_ct uuid; v_qty numeric; v_up numeric; v_pct numeric;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = p_id;
  IF v_c.id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'charge'); END IF;
  v_tx := app.g3_lock_tx(v_c.transaction_id, app.fin_write_roles());
  PERFORM app.only_keys(p_payload, ARRAY['description','vat_rate','service_code','container_id','note','quantity','unit_price','markup_pct']);
  IF p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = p_id FOR UPDATE;
  IF v_c.status <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.status); END IF;
  IF (p_payload ? 'quantity' OR p_payload ? 'unit_price') AND v_c.source <> 'manual' THEN PERFORM app.fail('MRS_INVALID', 'unit_price'); END IF;
  IF p_payload ? 'markup_pct' AND v_c.source <> 'markup' THEN PERFORM app.fail('MRS_INVALID', 'markup_pct'); END IF;
  IF p_payload ? 'service_code' THEN v_svc := app.ptext(p_payload, 'service_code', 40); PERFORM app.fin_check_service(v_svc); END IF;
  IF p_payload ? 'container_id' THEN v_ct := app.puuid(p_payload, 'container_id'); PERFORM app.g3_check_container(v_tx.id, v_ct); END IF;
  IF p_payload ? 'quantity' THEN
    v_qty := app.pnum(p_payload, 'quantity', 99999999999);
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> round(v_qty, 3) THEN PERFORM app.fail('MRS_INVALID', 'quantity'); END IF;
  END IF;
  IF p_payload ? 'unit_price' THEN
    v_up := app.fin_money(p_payload, 'unit_price');
    IF v_up IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'unit_price'); END IF;
  END IF;
  IF p_payload ? 'markup_pct' THEN
    v_pct := app.pnum(p_payload, 'markup_pct', 1000);
    IF v_pct IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'markup_pct'); END IF;
    v_up := round(v_c.cost_snapshot * (1 + v_pct / 100), 2);       -- re-priced from the snapshot, never from today's cost
  END IF;
  UPDATE public.client_charges c SET
    description  = CASE WHEN p_payload ? 'description' THEN app.ptext(p_payload, 'description', 300, true) ELSE c.description END,
    vat_rate     = CASE WHEN p_payload ? 'vat_rate' THEN coalesce(app.pnum(p_payload, 'vat_rate', 100), c.vat_rate) ELSE c.vat_rate END,
    service_code = CASE WHEN p_payload ? 'service_code' THEN v_svc ELSE c.service_code END,
    container_id = CASE WHEN p_payload ? 'container_id' THEN v_ct ELSE c.container_id END,
    note         = CASE WHEN p_payload ? 'note' THEN app.ptext(p_payload, 'note', 2000) ELSE c.note END,
    quantity     = coalesce(v_qty, c.quantity),
    unit_price   = coalesce(v_up, c.unit_price),
    markup_pct   = coalesce(v_pct, c.markup_pct)
   WHERE c.id = v_c.id RETURNING * INTO v_c;
  RETURN app.fin_charge_json(v_c);
END $$;

-- set_charge_status(p_id, approved|draft|void|invoiced, p_note)
--   draft → approved | void;  approved → void (note) | draft (note). Every change → fin_approve. invoiced: G5 only.
CREATE OR REPLACE FUNCTION public.set_charge_status(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.client_charges; v_from text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = p_id;
  IF v_c.id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'charge'); END IF;
  IF p_status = 'invoiced' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'g5_only'); END IF;
  IF p_status IS NULL OR p_status NOT IN ('approved','draft','void') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  PERFORM app.g3_lock_tx(v_c.transaction_id, app.fin_approve_roles());
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = p_id FOR UPDATE;
  IF v_c.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT ((v_c.status = 'draft' AND p_status IN ('approved','void')) OR (v_c.status = 'approved' AND p_status IN ('void','draft'))) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', v_c.status);
  END IF;
  IF (p_status = 'void' OR v_c.status = 'approved') AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF v_c.status = 'approved' AND EXISTS (SELECT 1 FROM public.charge_collections k WHERE k.charge_id = v_c.id AND k.status = 'recorded') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'has_collections');
  END IF;
  v_from := v_c.status;
  UPDATE public.client_charges c SET status = p_status,
    approved_by = CASE WHEN p_status = 'approved' THEN auth.uid() END,
    approved_at = CASE WHEN p_status = 'approved' THEN now() END,
    void_reason = CASE WHEN p_status = 'void' THEN v_note ELSE c.void_reason END,
    note = CASE WHEN v_note IS NOT NULL AND p_status <> 'void' THEN v_note ELSE c.note END
   WHERE c.id = v_c.id RETURNING * INTO v_c;
  PERFORM app.fin_event(v_c.org_id, v_c.transaction_id, 'charge_status', 'client_charge', v_c.id, v_from, p_status);
  RETURN app.fin_charge_json(v_c) || jsonb_build_object('from', v_from);
END $$;

-- ---------------------------------------------------------------------
-- 9. charge collections (evidence; append-only, capped by the charge total)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_collection_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.client_charges; v_sum numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status','void_reason','voided_by','voided_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','void_reason','voided_by','voided_at'])
       OR NOT (OLD.status = 'recorded' AND NEW.status = 'void') THEN
      PERFORM app.fail('MRS_APPEND_ONLY', TG_TABLE_NAME);
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = NEW.charge_id FOR UPDATE;
  IF v_c.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'charge_id'); END IF;
  IF v_c.status <> 'approved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'charge_' || v_c.status); END IF;
  NEW.currency := v_c.currency; NEW.transaction_id := v_c.transaction_id; NEW.org_id := v_c.org_id;
  NEW.status := 'recorded'; NEW.void_reason := NULL; NEW.voided_by := NULL; NEW.voided_at := NULL;
  SELECT coalesce(sum(k.amount), 0) INTO v_sum FROM public.charge_collections k WHERE k.charge_id = v_c.id AND k.status = 'recorded';
  IF v_sum + NEW.amount > v_c.total_amount THEN PERFORM app.fail('MRS_OVERPAID', greatest(v_c.total_amount - v_sum, 0)::text); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_collection_check ON public.charge_collections;
CREATE TRIGGER trg_collection_check BEFORE INSERT OR UPDATE ON public.charge_collections FOR EACH ROW EXECUTE FUNCTION app.tg_collection_check();

-- record_charge_collection({charge_id, amount, collected_at?, method, reference?, evidence_document_id?}, p_idem_key)
CREATE OR REPLACE FUNCTION public.record_charge_collection(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.client_charges; v_cid uuid; v_replay jsonb; v_amount numeric; v_at date; v_method text; v_ev uuid; v_ref text;
  v_k public.charge_collections;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['charge_id','amount','collected_at','method','reference','evidence_document_id','idempotencyKey']);
  v_cid := app.puuid(p_payload, 'charge_id');
  IF v_cid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'charge_id'); END IF;
  SELECT * INTO v_c FROM public.client_charges c WHERE c.id = v_cid;
  IF v_c.id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'charge'); END IF;
  PERFORM app.g3_lock_tx(v_c.transaction_id, app.fin_write_roles());
  v_replay := app.idem_begin('record_charge_collection', p_idem_key, p_payload - 'idempotencyKey', v_c.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_amount := app.fin_money(p_payload, 'amount');
  IF v_amount IS NULL OR v_amount <= 0 THEN PERFORM app.fail('MRS_INVALID', 'amount'); END IF;
  v_at := coalesce(app.pdate(p_payload, 'collected_at'), current_date);
  IF v_at > current_date + 1 THEN PERFORM app.fail('MRS_INVALID', 'collected_at'); END IF;
  v_method := app.ptext(p_payload, 'method', 20, true);
  IF NOT app.is_code('fin_payment_method', v_method) THEN PERFORM app.fail('MRS_INVALID', 'method'); END IF;
  v_ev := app.puuid(p_payload, 'evidence_document_id');
  PERFORM app.fin_check_findoc(v_c.org_id, (SELECT t.branch_id FROM public.transactions t WHERE t.id = v_c.transaction_id),
                               v_ev, 'evidence_document_id');
  v_ref := app.ptext(p_payload, 'reference', 120);
  IF v_ref IS NULL AND v_ev IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'reference_or_evidence'); END IF;
  INSERT INTO public.charge_collections (org_id, charge_id, transaction_id, amount, currency, collected_at, method, reference,
                                         evidence_document_id, created_by)
  VALUES (v_c.org_id, v_c.id, v_c.transaction_id, v_amount, v_c.currency, v_at, v_method, v_ref, v_ev, auth.uid())
  RETURNING * INTO v_k;
  PERFORM app.fin_event(v_k.org_id, v_k.transaction_id, 'collection_recorded', 'charge_collection', v_k.id, NULL, 'recorded',
                        jsonb_build_object('charge_id', v_c.id));
  RETURN app.idem_finish('record_charge_collection', p_idem_key, to_jsonb(v_k));
END $$;

-- void_charge_collection(p_id, p_reason) — fin_approve
CREATE OR REPLACE FUNCTION public.void_charge_collection(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_k public.charge_collections; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_k FROM public.charge_collections k WHERE k.id = p_id;
  IF v_k.id IS NULL OR NOT app.has_tx_role(v_k.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'collection'); END IF;
  PERFORM app.g3_lock_tx(v_k.transaction_id, app.fin_approve_roles());
  v_reason := app.fin_note(p_reason, 'reason');
  SELECT * INTO v_k FROM public.charge_collections k WHERE k.id = p_id FOR UPDATE;
  IF v_k.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_k.status); END IF;
  UPDATE public.charge_collections k SET status = 'void', void_reason = v_reason, voided_by = auth.uid(), voided_at = now()
   WHERE k.id = v_k.id RETURNING * INTO v_k;
  PERFORM app.fin_event(v_k.org_id, v_k.transaction_id, 'collection_voided', 'charge_collection', v_k.id, 'recorded', 'void',
                        jsonb_build_object('charge_id', v_k.charge_id));
  RETURN to_jsonb(v_k) || jsonb_build_object('from', 'recorded');
END $$;

-- ---------------------------------------------------------------------
-- 10. demurrage cases
-- ---------------------------------------------------------------------
-- the four figures (gross = incl. VAT), each from its own records — nothing is derived from another figure
CREATE OR REPLACE FUNCTION app.fin_demurrage_figures(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.demurrage_cases; v_charged numeric; v_collected numeric; v_paid numeric; v_paid_cl numeric; v_due numeric;
  v_level text; v_n int;
BEGIN
  SELECT * INTO c FROM public.demurrage_cases x WHERE x.id = p_case;
  -- every figure is in the case currency (allocations / charges in another currency are refused at write time;
  -- the filter keeps any legacy row from being summed under the wrong currency)
  SELECT coalesce(sum(ch.total_amount), 0) INTO v_charged FROM public.client_charges ch
   WHERE ch.demurrage_case_id = c.id AND ch.status IN ('approved','invoiced') AND ch.currency = c.currency;
  SELECT coalesce(sum(k.amount), 0) INTO v_collected FROM public.charge_collections k JOIN public.client_charges ch ON ch.id = k.charge_id
   WHERE ch.demurrage_case_id = c.id AND ch.status IN ('approved','invoiced') AND k.status = 'recorded' AND ch.currency = c.currency;
  -- paid by the client: only this case's client's direct payments (app.fin_client_share); paid by the company: its payments
  -- spread over what the clients did not pay (payable − client-direct), never more than the allocation's gross
  SELECT count(*),
         coalesce(sum(g.sgn * g.gross), 0),
         coalesce(sum(CASE WHEN g.rest > 0 THEN g.gross * (1 - g.sh) * least(g.co / g.rest, 1) ELSE 0 END), 0),
         coalesce(sum(g.gross * g.sh), 0)
    INTO v_n, v_due, v_paid, v_paid_cl
    FROM (SELECT CASE WHEN l.net_amount > 0 THEN a.amount * l.total_amount / l.net_amount ELSE a.amount END AS gross,
                 CASE WHEN si.doc_type = 'credit_note' THEN -1 ELSE 1 END AS sgn,
                 app.fin_invoice_payable(si.id) - si.client_paid_amount AS rest, si.company_paid_amount AS co,
                 CASE WHEN si.client_paid_amount > 0 THEN app.fin_client_share(si.id, t.client_id) ELSE 0 END AS sh
            FROM public.cost_allocations a
            JOIN public.supplier_invoice_lines l ON l.id = a.line_id
            JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id
            JOIN public.transactions t ON t.id = a.transaction_id
           WHERE a.demurrage_case_id = c.id AND a.status = 'approved' AND si.status <> 'void' AND si.currency = c.currency) g;
  IF v_n > 0 THEN
    v_level := 'allocated';
  ELSIF c.estimated_amount IS NOT NULL AND c.status IN ('open','closed') THEN
    v_due := c.estimated_amount * (1 + c.estimated_vat_rate / 100); v_level := 'estimated';
  ELSE
    v_due := 0; v_level := CASE WHEN c.status IN ('waived','void') THEN 'none' ELSE 'unknown' END;
  END IF;
  v_due := round(v_due, 2); v_paid := round(v_paid, 2); v_paid_cl := round(v_paid_cl, 2);
  RETURN jsonb_build_object('currency', c.currency,
    'charged_to_client', v_charged, 'collected_from_client', v_collected,
    'paid_to_operator', v_paid, 'paid_by_client_to_operator', v_paid_cl,
    'operator_due', v_due, 'operator_due_level', v_level,
    'remaining', jsonb_build_object('to_collect', v_charged - v_collected, 'to_pay_operator', v_due - v_paid - v_paid_cl));
END $$;

CREATE OR REPLACE FUNCTION app.fin_case_json(c public.demurrage_cases) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(c) || jsonb_build_object('figures', app.fin_demurrage_figures(c.id),
    'accrual_id', (SELECT x.id FROM public.cost_accruals x WHERE x.demurrage_case_id = c.id AND x.status <> 'void' LIMIT 1),
    'branch_id', (SELECT t.branch_id FROM public.transactions t WHERE t.id = c.transaction_id))
$$;

-- payload → case fields (keys present only)
CREATE OR REPLACE FUNCTION app.fin_case_fields(p jsonb, p_tx public.transactions) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; s text; n numeric;
BEGIN
  IF p ? 'container_id' THEN
    v := v || jsonb_build_object('container_id', app.puuid(p, 'container_id'));
    PERFORM app.g3_check_container(p_tx.id, (v ->> 'container_id')::uuid);
  END IF;
  IF p ? 'kind' THEN
    s := app.ptext(p, 'kind', 20, true);
    IF s NOT IN ('storage','demurrage','detention') THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
    v := v || jsonb_build_object('kind', s);
  END IF;
  IF p ? 'operator_id' THEN
    v := v || jsonb_build_object('operator_id', app.puuid(p, 'operator_id'));
    PERFORM app.g3_check_party(p_tx.org_id, (v ->> 'operator_id')::uuid, ARRAY['terminal_operator','shipping_agent','yard'], 'operator_id');
  END IF;
  IF p ? 'exception_id' THEN
    v := v || jsonb_build_object('exception_id', app.puuid(p, 'exception_id'));
    IF v ->> 'exception_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.operational_exceptions e
         WHERE e.id = (v ->> 'exception_id')::uuid AND e.transaction_id = p_tx.id) THEN
      PERFORM app.fail('MRS_INVALID', 'exception_id');
    END IF;
  END IF;
  IF p ? 'free_until' THEN v := v || jsonb_build_object('free_until', app.pdate(p, 'free_until')); END IF;
  IF p ? 'charged_until' THEN v := v || jsonb_build_object('charged_until', app.pdate(p, 'charged_until')); END IF;
  IF p ? 'days' THEN
    n := app.pnum(p, 'days', 3650);
    IF n IS NOT NULL AND n <> trunc(n) THEN PERFORM app.fail('MRS_INVALID', 'days'); END IF;
    v := v || jsonb_build_object('days', n);
  END IF;
  IF p ? 'estimated_amount' THEN v := v || jsonb_build_object('estimated_amount', app.fin_money(p, 'estimated_amount')); END IF;
  IF p ? 'estimated_vat_rate' THEN v := v || jsonb_build_object('estimated_vat_rate', coalesce(app.pnum(p, 'estimated_vat_rate', 100), 15)); END IF;
  IF p ? 'currency' THEN v := v || jsonb_build_object('currency', coalesce(app.fin_currency(p, 'currency'), 'SAR')); END IF;
  IF p ? 'status_note' THEN v := v || jsonb_build_object('status_note', app.ptext(p, 'status_note', 2000)); END IF;
  RETURN v;
END $$;

-- create_demurrage_case({transaction_id, kind, container_id?, operator_id?, exception_id?, free_until?, charged_until?, days?,
--   estimated_amount?, estimated_vat_rate?, currency?, status_note?}, p_idem_key)
CREATE OR REPLACE FUNCTION public.create_demurrage_case(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_txid uuid; v_replay jsonb; v_f jsonb; v_c public.demurrage_cases; v_days int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['transaction_id','container_id','kind','operator_id','exception_id','free_until','charged_until',
    'days','estimated_amount','estimated_vat_rate','currency','status_note','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles());
  v_replay := app.idem_begin('create_demurrage_case', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT (p_payload ? 'kind') THEN PERFORM app.fail('MRS_REQUIRED', 'kind'); END IF;
  v_f := app.fin_case_fields(p_payload - 'idempotencyKey' - 'transaction_id', v_tx);
  IF (v_f ->> 'charged_until')::date < (v_f ->> 'free_until')::date THEN PERFORM app.fail('MRS_INVALID', 'charged_until'); END IF;
  v_days := coalesce((v_f ->> 'days')::int, ((v_f ->> 'charged_until')::date - (v_f ->> 'free_until')::date));
  INSERT INTO public.demurrage_cases (org_id, transaction_id, container_id, kind, operator_id, exception_id, free_until, charged_until,
    days, estimated_amount, estimated_vat_rate, currency, status_note, created_by)
  VALUES (v_tx.org_id, v_tx.id, (v_f ->> 'container_id')::uuid, v_f ->> 'kind', (v_f ->> 'operator_id')::uuid,
    (v_f ->> 'exception_id')::uuid, (v_f ->> 'free_until')::date, (v_f ->> 'charged_until')::date, v_days,
    (v_f ->> 'estimated_amount')::numeric, coalesce((v_f ->> 'estimated_vat_rate')::numeric, 15), coalesce(v_f ->> 'currency', 'SAR'),
    v_f ->> 'status_note', auth.uid())
  RETURNING * INTO v_c;
  PERFORM app.fin_event(v_c.org_id, v_c.transaction_id, 'demurrage_created', 'demurrage_case', v_c.id, NULL, 'open',
    jsonb_strip_nulls(jsonb_build_object('kind', v_c.kind, 'container_id', v_c.container_id, 'exception_id', v_c.exception_id)));
  RETURN app.idem_finish('create_demurrage_case', p_idem_key, app.fin_case_json(v_c));
END $$;

-- update_demurrage_case(p_id, {same fields}) — open only
CREATE OR REPLACE FUNCTION public.update_demurrage_case(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.demurrage_cases; v_new public.demurrage_cases; v_tx public.transactions; v_f jsonb; v_changed jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.demurrage_cases c WHERE c.id = p_id;
  IF v_c.id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'demurrage_case'); END IF;
  v_tx := app.g3_lock_tx(v_c.transaction_id, app.fin_write_roles());
  PERFORM app.only_keys(p_payload, ARRAY['container_id','kind','operator_id','exception_id','free_until','charged_until','days',
    'estimated_amount','estimated_vat_rate','currency','status_note']);
  IF p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  SELECT * INTO v_c FROM public.demurrage_cases c WHERE c.id = p_id FOR UPDATE;
  IF v_c.status <> 'open' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.status); END IF;
  v_f := app.fin_case_fields(p_payload, v_tx);
  IF v_f ? 'currency' AND (v_f ->> 'currency') IS DISTINCT FROM v_c.currency::text
     AND (EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.demurrage_case_id = v_c.id AND a.status IN ('proposed','approved'))
          OR EXISTS (SELECT 1 FROM public.client_charges ch WHERE ch.demurrage_case_id = v_c.id AND ch.status <> 'void')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'currency_in_use');
  END IF;
  UPDATE public.demurrage_cases c SET
    container_id       = CASE WHEN v_f ? 'container_id' THEN (v_f ->> 'container_id')::uuid ELSE c.container_id END,
    kind               = coalesce(v_f ->> 'kind', c.kind),
    operator_id        = CASE WHEN v_f ? 'operator_id' THEN (v_f ->> 'operator_id')::uuid ELSE c.operator_id END,
    exception_id       = CASE WHEN v_f ? 'exception_id' THEN (v_f ->> 'exception_id')::uuid ELSE c.exception_id END,
    free_until         = CASE WHEN v_f ? 'free_until' THEN (v_f ->> 'free_until')::date ELSE c.free_until END,
    charged_until      = CASE WHEN v_f ? 'charged_until' THEN (v_f ->> 'charged_until')::date ELSE c.charged_until END,
    days               = CASE WHEN v_f ? 'days' THEN (v_f ->> 'days')::int ELSE c.days END,
    estimated_amount   = CASE WHEN v_f ? 'estimated_amount' THEN (v_f ->> 'estimated_amount')::numeric ELSE c.estimated_amount END,
    estimated_vat_rate = coalesce((v_f ->> 'estimated_vat_rate')::numeric, c.estimated_vat_rate),
    currency           = coalesce(v_f ->> 'currency', c.currency),
    status_note        = CASE WHEN v_f ? 'status_note' THEN v_f ->> 'status_note' ELSE c.status_note END
   WHERE c.id = v_c.id RETURNING * INTO v_new;
  SELECT jsonb_agg(k ORDER BY k) INTO v_changed FROM jsonb_object_keys(v_f) k WHERE (to_jsonb(v_new) -> k) IS DISTINCT FROM (to_jsonb(v_c) -> k);
  IF v_changed IS NOT NULL THEN
    PERFORM app.fin_event(v_new.org_id, v_new.transaction_id, 'demurrage_updated', 'demurrage_case', v_new.id, v_new.status, v_new.status,
                          jsonb_build_object('changed', v_changed));
  END IF;
  RETURN app.fin_case_json(v_new) || jsonb_build_object('changed', coalesce(v_changed, '[]'::jsonb));
END $$;

-- set_demurrage_status(p_id, closed|waived|void|open, p_note) — open → closed | waived | void; closed → open | waived | void.
-- waived / void need fin_approve and a note.
CREATE OR REPLACE FUNCTION public.set_demurrage_status(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.demurrage_cases; v_tx public.transactions; v_from text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.demurrage_cases c WHERE c.id = p_id;
  IF v_c.id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'demurrage_case'); END IF;
  IF p_status IS NULL OR p_status NOT IN ('open','closed','waived','void') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_tx := app.g3_lock_tx(v_c.transaction_id, CASE WHEN p_status IN ('waived','void') THEN app.fin_approve_roles() ELSE app.fin_write_roles() END);
  SELECT * INTO v_c FROM public.demurrage_cases c WHERE c.id = p_id FOR UPDATE;
  IF v_c.status = p_status THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF v_c.status IN ('waived','void') OR (v_c.status = 'open' AND p_status = 'open') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.status); END IF;
  IF p_status IN ('waived','void') AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  v_from := v_c.status;
  UPDATE public.demurrage_cases c SET status = p_status, status_note = coalesce(v_note, c.status_note)
   WHERE c.id = v_c.id RETURNING * INTO v_c;
  PERFORM app.fin_event(v_c.org_id, v_c.transaction_id, 'demurrage_status', 'demurrage_case', v_c.id, v_from, p_status);
  RETURN app.fin_case_json(v_c) || jsonb_build_object('from', v_from);
END $$;

-- ---------------------------------------------------------------------
-- 11. cost adjustments
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fin_can_read_adjustment(p_tx uuid, p_si uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (p_tx IS NOT NULL AND app.has_tx_role(p_tx, app.fin_read_roles()))
      OR (p_si IS NOT NULL AND app.fin_can_read_invoice(p_si))
$$;

-- create_cost_adjustment({kind, reason, transaction_id?, container_id?, supplier_invoice_id?, related_invoice_id?, exception_id?,
--   supplier_id?, service_code?, amount?, currency?, finance_document_id?, document_id?}, p_idem_key)
CREATE OR REPLACE FUNCTION public.create_cost_adjustment(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions; v_txid uuid; v_si public.supplier_invoices; v_siid uuid; v_rel public.supplier_invoices; v_relid uuid;
  v_org uuid; v_replay jsonb; v_kind text; v_reason text; v_ct uuid; v_exc uuid; v_sup uuid; v_svc text; v_cur text;
  v_fd uuid; v_doc uuid; v_x public.cost_adjustments;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['kind','reason','transaction_id','container_id','supplier_invoice_id','related_invoice_id',
    'exception_id','supplier_id','service_code','amount','currency','finance_document_id','document_id','idempotencyKey']);
  v_txid := app.puuid(p_payload, 'transaction_id');
  v_siid := app.puuid(p_payload, 'supplier_invoice_id');
  IF v_txid IS NULL AND v_siid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_or_invoice'); END IF;
  -- lock order: transaction → invoice
  IF v_txid IS NOT NULL THEN v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles()); v_org := v_tx.org_id; END IF;
  IF v_siid IS NOT NULL THEN
    v_si := app.fin_lock_invoice(v_siid, app.fin_write_roles());
    IF v_org IS NOT NULL AND v_si.org_id <> v_org THEN PERFORM app.fail('MRS_INVALID', 'supplier_invoice_id'); END IF;
    v_org := v_si.org_id;
  END IF;
  v_replay := app.idem_begin('create_cost_adjustment', p_idem_key, p_payload - 'idempotencyKey', v_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_kind := app.ptext(p_payload, 'kind', 30, true);
  IF NOT app.is_code('fin_adjustment_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_reason := app.fin_note(app.ptext(p_payload, 'reason', 2000), 'reason');
  IF v_kind IN ('duplicate_invoice','amendment') AND v_si.id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'supplier_invoice_id'); END IF;
  v_relid := app.puuid(p_payload, 'related_invoice_id');
  IF v_kind = 'duplicate_invoice' AND v_relid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'related_invoice_id'); END IF;
  IF v_relid IS NOT NULL THEN
    SELECT * INTO v_rel FROM public.supplier_invoices si WHERE si.id = v_relid AND si.org_id = v_org;
    IF v_rel.id IS NULL OR v_rel.id = v_si.id OR (v_kind = 'duplicate_invoice' AND v_rel.supplier_id IS DISTINCT FROM v_si.supplier_id)
       OR NOT app.fin_can_read_invoice(v_rel.id) THEN
      PERFORM app.fail('MRS_INVALID', 'related_invoice_id');
    END IF;
  END IF;
  v_ct := app.puuid(p_payload, 'container_id');
  v_exc := app.puuid(p_payload, 'exception_id');
  IF (v_ct IS NOT NULL OR v_exc IS NOT NULL) AND v_tx.id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  IF v_ct IS NOT NULL THEN PERFORM app.g3_check_container(v_tx.id, v_ct); END IF;
  IF v_exc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.operational_exceptions e WHERE e.id = v_exc AND e.transaction_id = v_tx.id) THEN
    PERFORM app.fail('MRS_INVALID', 'exception_id');
  END IF;
  v_sup := coalesce(app.puuid(p_payload, 'supplier_id'), v_si.supplier_id);
  IF v_sup IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id = v_sup AND pa.org_id = v_org) THEN
    PERFORM app.fail('MRS_INVALID', 'supplier_id');
  END IF;
  v_svc := app.ptext(p_payload, 'service_code', 40);
  PERFORM app.fin_check_service(v_svc);
  v_cur := coalesce(app.fin_currency(p_payload, 'currency'), v_si.currency::text, 'SAR');
  v_fd := app.puuid(p_payload, 'finance_document_id');
  PERFORM app.fin_check_findoc(v_org, coalesce(v_tx.branch_id, v_si.branch_id), v_fd, 'finance_document_id');
  v_doc := app.puuid(p_payload, 'document_id');
  PERFORM app.fin_check_txdoc(v_org, v_doc, 'document_id');
  IF v_fd IS NULL AND v_doc IS NULL AND v_si.id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'document'); END IF;
  INSERT INTO public.cost_adjustments (org_id, kind, transaction_id, container_id, supplier_invoice_id, related_invoice_id, exception_id,
    supplier_id, service_code, amount, currency, finance_document_id, document_id, reason, created_by)
  VALUES (v_org, v_kind, v_tx.id, v_ct, v_si.id, v_relid, v_exc, v_sup, v_svc, app.fin_money(p_payload, 'amount'), v_cur, v_fd, v_doc,
          v_reason, auth.uid())
  RETURNING * INTO v_x;
  PERFORM app.fin_event(v_x.org_id, v_x.transaction_id, 'adjustment_created', 'cost_adjustment', v_x.id, NULL, 'proposed',
    jsonb_strip_nulls(jsonb_build_object('kind', v_x.kind, 'supplier_invoice_id', v_x.supplier_invoice_id)));
  RETURN app.idem_finish('create_cost_adjustment', p_idem_key, to_jsonb(v_x));
END $$;

-- review_cost_adjustment(p_id, approved|rejected, p_note) — fin_approve (transaction and invoice branch), four eyes, note.
--   approved fee (transaction + amount, no invoice) → an expected cost (source='adjustment' accrual)
--   approved duplicate_invoice → the duplicate becomes void (duplicate_of_id); its file and lines stay, contributing nothing
CREATE OR REPLACE FUNCTION public.review_cost_adjustment(p_id uuid, p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_x public.cost_adjustments; v_note text; v_si public.supplier_invoices; v_acc public.cost_accruals;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_x FROM public.cost_adjustments x WHERE x.id = p_id;
  IF v_x.id IS NULL OR NOT app.fin_can_read_adjustment(v_x.transaction_id, v_x.supplier_invoice_id) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'adjustment');
  END IF;
  IF v_x.transaction_id IS NOT NULL THEN PERFORM app.g3_lock_tx(v_x.transaction_id, app.fin_approve_roles()); END IF;
  IF v_x.supplier_invoice_id IS NOT NULL THEN v_si := app.fin_lock_invoice(v_x.supplier_invoice_id, app.fin_approve_roles()); END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.fin_note(p_note, 'note');
  SELECT * INTO v_x FROM public.cost_adjustments x WHERE x.id = p_id FOR UPDATE;
  IF v_x.status <> 'proposed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_x.status); END IF;
  PERFORM app.fin_four_eyes(v_x.org_id, v_x.created_by);
  IF p_decision = 'approved' THEN
    IF v_x.kind = 'duplicate_invoice' THEN
      v_si := app.fin_void_invoice(v_si, 'duplicate', v_x.related_invoice_id);
    ELSIF v_x.kind IN ('empty_fee','washing','repair','late_cost','other') AND v_x.transaction_id IS NOT NULL
          AND v_x.amount IS NOT NULL AND v_x.supplier_invoice_id IS NULL THEN
      INSERT INTO public.cost_accruals (org_id, transaction_id, container_id, source, adjustment_id, supplier_id, service_code, amount,
                                        currency, basis, created_by)
      VALUES (v_x.org_id, v_x.transaction_id, v_x.container_id, 'adjustment', v_x.id, v_x.supplier_id,
              coalesce(v_x.service_code, CASE v_x.kind WHEN 'washing' THEN 'washing' WHEN 'repair' THEN 'repair'
                                                       WHEN 'empty_fee' THEN 'empty_handling' ELSE 'other' END),
              v_x.amount, v_x.currency, 'estimated', auth.uid())
      RETURNING * INTO v_acc;
    END IF;
  END IF;
  UPDATE public.cost_adjustments x SET status = p_decision, reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note,
         accrual_id = coalesce(v_acc.id, x.accrual_id)
   WHERE x.id = v_x.id RETURNING * INTO v_x;
  PERFORM app.fin_event(v_x.org_id, v_x.transaction_id, 'adjustment_reviewed', 'cost_adjustment', v_x.id, 'proposed', p_decision,
    jsonb_strip_nulls(jsonb_build_object('kind', v_x.kind, 'accrual_id', v_acc.id, 'supplier_invoice_id', v_x.supplier_invoice_id)));
  RETURN to_jsonb(v_x) || jsonb_build_object('from', 'proposed',
    'voided_invoice_id', CASE WHEN v_x.kind = 'duplicate_invoice' AND p_decision = 'approved' THEN v_x.supplier_invoice_id END);
END $$;

-- ---------------------------------------------------------------------
-- 12. cost items (each cost counted exactly once), margins, reports
-- ---------------------------------------------------------------------
-- allocation  : approved allocations on non-void invoices (− for credit notes); confirmed when the invoice is approved
-- accrual     : open accruals, amount − matched (≥ 0) — estimated, or unknown when the amount is NULL
-- overhead    : overhead lines (no transaction; invoice branch)
-- unallocated : ok / disputed / pending_review lines minus their approved allocations (unknown attribution)
-- matched / variance / void accruals and proposed / rejected / reversed allocations add 0; excluded lines add 0.
CREATE OR REPLACE FUNCTION app.fin_cost_items(p_org uuid, p_tx uuid DEFAULT NULL)
RETURNS TABLE (org_id uuid, branch_id uuid, transaction_id uuid, client_id uuid, supplier_id uuid, service_code text, currency text,
               amount numeric, level text, source text, ref_id uuid, item_date date, is_pass_through boolean, client_paid_share numeric,
               supplier_invoice_id uuid, line_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH inv AS (
    SELECT si.id, si.org_id, si.branch_id, si.supplier_id, si.currency::text AS currency, si.status, si.invoice_date,
           si.client_paid_amount > 0 AS client_paid,
           CASE WHEN si.doc_type = 'credit_note' THEN -1 ELSE 1 END AS sgn
      FROM public.supplier_invoices si WHERE si.org_id = p_org AND si.status <> 'void'),
  appr AS (
    SELECT a.line_id, sum(a.amount) AS amt FROM public.cost_allocations a
     WHERE a.org_id = p_org AND a.status = 'approved' GROUP BY a.line_id)
  SELECT a.org_id, t.branch_id, a.transaction_id, t.client_id, inv.supplier_id, a.service_code, inv.currency,
         inv.sgn * a.amount, CASE WHEN inv.status = 'approved' THEN 'confirmed' ELSE 'estimated' END, 'allocation', a.id,
         inv.invoice_date,
         -- pass-through only once the disbursement is really billed (approved / invoiced); a draft keeps the cost in the margin
         EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status IN ('approved','invoiced') AND c.kind = 'reimbursable'
                  AND (c.cost_allocation_id = a.id OR (a.accrual_id IS NOT NULL AND c.accrual_id = a.accrual_id))),
         -- a client's direct payment covers only that client's allocations on the invoice
         CASE WHEN inv.client_paid THEN app.fin_client_share(inv.id, t.client_id) ELSE 0 END, inv.id, a.line_id
    FROM public.cost_allocations a JOIN inv ON inv.id = a.supplier_invoice_id JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.status = 'approved' AND (p_tx IS NULL OR a.transaction_id = p_tx)
  UNION ALL
  SELECT x.org_id, t.branch_id, x.transaction_id, t.client_id, x.supplier_id, x.service_code, x.currency::text,
         CASE WHEN x.amount IS NULL THEN NULL ELSE greatest(x.amount - x.matched_amount, 0) END,
         CASE WHEN x.amount IS NULL THEN 'unknown' ELSE 'estimated' END, 'accrual', x.id, x.created_at::date,
         EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status IN ('approved','invoiced') AND c.kind = 'reimbursable' AND c.accrual_id = x.id),
         0::numeric, NULL::uuid, NULL::uuid
    FROM public.cost_accruals x JOIN public.transactions t ON t.id = x.transaction_id
   WHERE x.org_id = p_org AND x.status = 'open' AND (p_tx IS NULL OR x.transaction_id = p_tx)
     AND (x.amount IS NULL OR x.amount > x.matched_amount)
  UNION ALL
  SELECT l.org_id, inv.branch_id, NULL::uuid, NULL::uuid, inv.supplier_id, l.service_code, inv.currency, inv.sgn * l.net_amount,
         CASE WHEN inv.status = 'approved' THEN 'confirmed' ELSE 'estimated' END, 'overhead', l.id, inv.invoice_date, false,
         0::numeric, inv.id, l.id
    FROM public.supplier_invoice_lines l JOIN inv ON inv.id = l.supplier_invoice_id
   WHERE p_tx IS NULL AND l.review_status = 'overhead' AND l.net_amount <> 0
  UNION ALL
  SELECT l.org_id, inv.branch_id, NULL::uuid, NULL::uuid, inv.supplier_id, l.service_code, inv.currency,
         inv.sgn * (l.net_amount - coalesce(appr.amt, 0)), 'unknown', 'unallocated', l.id, inv.invoice_date, false,
         0::numeric, inv.id, l.id
    FROM public.supplier_invoice_lines l JOIN inv ON inv.id = l.supplier_invoice_id LEFT JOIN appr ON appr.line_id = l.id
   WHERE p_tx IS NULL AND l.review_status IN ('ok','disputed','pending_review') AND l.net_amount - coalesce(appr.amt, 0) <> 0
$$;

-- per-currency figures of one transaction
CREATE OR REPLACE FUNCTION app.fin_tx_currency_rows(p_org uuid, p_tx uuid)
RETURNS TABLE (currency text, charges_service numeric, charges_internal numeric, charges_draft numeric, reimbursable_charged numeric,
               cost_confirmed numeric, cost_estimated numeric, unknown_count int, pass_through_cost numeric, pass_through_net numeric,
               client_paid_direct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH it AS (SELECT * FROM app.fin_cost_items(p_org, p_tx)),
  ch AS (SELECT c.currency::text AS currency, c.kind, c.status, c.net_amount FROM public.client_charges c
          WHERE c.transaction_id = p_tx AND c.status <> 'void'),
  cur AS (SELECT it.currency FROM it UNION SELECT ch.currency FROM ch)
  SELECT cur.currency,
    coalesce((SELECT sum(ch.net_amount) FROM ch WHERE ch.currency = cur.currency AND ch.status IN ('approved','invoiced')
                AND ch.kind IN ('service','internal_service')), 0),
    coalesce((SELECT sum(ch.net_amount) FROM ch WHERE ch.currency = cur.currency AND ch.status IN ('approved','invoiced')
                AND ch.kind = 'internal_service'), 0),
    coalesce((SELECT sum(ch.net_amount) FROM ch WHERE ch.currency = cur.currency AND ch.status = 'draft'), 0),
    coalesce((SELECT sum(ch.net_amount) FROM ch WHERE ch.currency = cur.currency AND ch.status IN ('approved','invoiced')
                AND ch.kind = 'reimbursable'), 0),
    round(coalesce((SELECT sum(it.amount * (1 - it.client_paid_share)) FROM it WHERE it.currency = cur.currency
                      AND it.level = 'confirmed' AND NOT it.is_pass_through), 0), 2),
    round(coalesce((SELECT sum(it.amount * (1 - it.client_paid_share)) FROM it WHERE it.currency = cur.currency
                      AND it.level = 'estimated' AND NOT it.is_pass_through), 0), 2),
    (SELECT count(*) FROM it WHERE it.currency = cur.currency AND it.level = 'unknown')::int,
    round(coalesce((SELECT sum(it.amount) FROM it WHERE it.currency = cur.currency AND it.is_pass_through), 0), 2),
    round(coalesce((SELECT sum(it.amount * (1 - it.client_paid_share)) FROM it WHERE it.currency = cur.currency AND it.is_pass_through), 0), 2),
    round(coalesce((SELECT sum(it.amount * it.client_paid_share) FROM it WHERE it.currency = cur.currency AND it.amount IS NOT NULL), 0), 2)
    FROM cur ORDER BY cur.currency
$$;

-- pending items of one transaction (they keep the margin from being "confirmed")
CREATE OR REPLACE FUNCTION app.fin_tx_pending(p_tx uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('type', p.type, 'id', p.id, 'label_ar', p.ar, 'label_en', p.en) ORDER BY p.ord, p.id), '[]'::jsonb)
    FROM (
      SELECT 1 ord, 'proposed_allocation' type, a.id, 'تخصيص تكلفة بانتظار الاعتماد' ar, 'Cost allocation awaiting approval' en
        FROM public.cost_allocations a WHERE a.transaction_id = p_tx AND a.status = 'proposed'
      UNION ALL
      SELECT 2, 'open_accrual', x.id, 'تكلفة متوقعة لم تُطابق بفاتورة', 'Expected cost not matched by an invoice'
        FROM public.cost_accruals x WHERE x.transaction_id = p_tx AND x.status = 'open' AND x.amount IS NOT NULL AND x.amount > x.matched_amount
      UNION ALL
      SELECT 3, 'unknown_accrual', x.id, 'تكلفة متوقعة بلا مبلغ', 'Expected cost without an amount'
        FROM public.cost_accruals x WHERE x.transaction_id = p_tx AND x.status = 'open' AND x.amount IS NULL
      UNION ALL
      SELECT 4, 'variance_accrual', x.id, 'فرق تكلفة بانتظار المراجعة', 'Cost variance awaiting review'
        FROM public.cost_accruals x WHERE x.transaction_id = p_tx AND x.status = 'variance'
      UNION ALL
      SELECT 5, 'draft_charge', c.id, 'مبلغ على العميل في المسودة', 'Draft client charge'
        FROM public.client_charges c WHERE c.transaction_id = p_tx AND c.status = 'draft'
      UNION ALL
      SELECT 6, 'open_demurrage', d.id, 'أرضيات / غرامة مفتوحة', 'Open storage / demurrage case'
        FROM public.demurrage_cases d WHERE d.transaction_id = p_tx AND d.status = 'open'
      UNION ALL
      SELECT 7, 'proposed_adjustment', j.id, 'تسوية بانتظار الاعتماد', 'Adjustment awaiting approval'
        FROM public.cost_adjustments j WHERE j.transaction_id = p_tx AND j.status = 'proposed'
      UNION ALL
      -- a billed amount whose cost source is gone (accrual void, allocation rejected / reversed, trip cancelled):
      -- review it (void, or re-create as a manual charge if it is a genuine fee)
      SELECT 8, 'charge_source_gone', c.id, 'مبلغ على العميل مصدره أُلغي', 'Client charge whose cost source is gone'
        FROM public.client_charges c WHERE c.transaction_id = p_tx AND c.status IN ('approved','invoiced')
         AND ((c.accrual_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.cost_accruals x WHERE x.id = c.accrual_id AND x.status = 'void'))
              OR (c.cost_allocation_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.cost_allocations a
                                                               WHERE a.id = c.cost_allocation_id AND a.status IN ('rejected','reversed')))
              OR (c.trip_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.transport_trips t WHERE t.id = c.trip_id AND t.status = 'cancelled')))) p
$$;

-- figures of one transaction: {currencies[], level, pending[], mixed_currency}
CREATE OR REPLACE FUNCTION app.fin_tx_figures(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_cur jsonb; v_pending jsonb; v_gaps jsonb; v_unknown int; v_est boolean; v_hint boolean; v_level text;
BEGIN
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  SELECT coalesce(jsonb_agg(jsonb_build_object('currency', r.currency,
           'charges_service', r.charges_service, 'charges_internal', r.charges_internal, 'charges_draft', r.charges_draft,
           'reimbursable_charged', r.reimbursable_charged, 'cost_confirmed', r.cost_confirmed, 'cost_estimated', r.cost_estimated,
           'unknown_count', r.unknown_count, 'pass_through_cost', r.pass_through_cost, 'client_paid_direct', r.client_paid_direct,
           'margin_confirmed', r.charges_service - r.cost_confirmed,
           'margin_expected', r.charges_service - r.cost_confirmed - r.cost_estimated,
           'reimbursable_gap', r.reimbursable_charged - r.pass_through_net) ORDER BY r.currency), '[]'::jsonb),
         coalesce(sum(r.unknown_count), 0), coalesce(bool_or(r.cost_estimated <> 0), false)
    INTO v_cur, v_unknown, v_est
    FROM app.fin_tx_currency_rows(v_tx.org_id, v_tx.id) r;
  SELECT coalesce(jsonb_agg(jsonb_build_object('type', 'reimbursable_gap', 'id', NULL, 'currency', c ->> 'currency',
           'label_ar', 'فرق بين المصروفات المستردة المحمّلة وتكلفتها', 'label_en', 'Reimbursable charges differ from their cost')), '[]'::jsonb)
    INTO v_gaps FROM jsonb_array_elements(v_cur) c WHERE (c ->> 'reimbursable_gap')::numeric <> 0;
  v_pending := app.fin_tx_pending(v_tx.id) || v_gaps;
  v_hint := EXISTS (
    SELECT 1 FROM public.supplier_invoice_lines l JOIN public.supplier_invoices si ON si.id = l.supplier_invoice_id
     WHERE si.org_id = v_tx.org_id AND si.status <> 'void' AND l.review_status IN ('ok','disputed','pending_review')
       AND l.reference_hint IS NOT NULL
       AND upper(btrim(l.reference_hint)) IN (upper(v_tx.ref), upper(coalesce(v_tx.bl_number, v_tx.ref)))
       AND l.net_amount > coalesce((SELECT sum(a.amount) FROM public.cost_allocations a WHERE a.line_id = l.id AND a.status = 'approved'), 0));
  v_level := CASE WHEN v_unknown > 0 OR v_hint THEN 'unknown'
                  WHEN v_est OR jsonb_array_length(v_pending) > 0 THEN 'estimated'
                  ELSE 'confirmed' END;
  RETURN jsonb_build_object('currencies', v_cur, 'level', v_level, 'pending', v_pending,
                            'mixed_currency', jsonb_array_length(v_cur) > 1, 'unallocated_hint', v_hint);
END $$;

-- tx_margin(p_tx) — analytical margin (ليس ربحًا محاسبيًا), per currency
CREATE OR REPLACE FUNCTION public.tx_margin(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.fin_tx_read(p_tx);
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'analytical', true) || app.fin_tx_figures(v_tx.id);
END $$;

-- margin_report(p_org, {branch_id?, client_id?, from?, to? (transaction created_at), operational_status?, level?, currency?,
--   limit ≤ 200 (50), offset?}) — one row per transaction and currency; transactions with no G4 data are left out
CREATE OR REPLACE FUNCTION public.margin_report(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_cl uuid; v_from date; v_to date; v_ost text; v_level text; v_cur text;
  v_limit int; v_offset int; r record; v_fig jsonb; c jsonb; v_items jsonb := '[]'::jsonb; v_totals jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['branch_id','client_id','from','to','operational_status','level','currency','limit','offset']);
  v_br := app.puuid(f, 'branch_id'); v_cl := app.puuid(f, 'client_id');
  v_from := app.pdate(f, 'from'); v_to := app.pdate(f, 'to');
  v_ost := app.ptext(f, 'operational_status', 40);
  IF v_ost IS NOT NULL AND NOT app.is_code('operational_status', v_ost) THEN PERFORM app.fail('MRS_INVALID', 'operational_status'); END IF;
  v_level := app.ptext(f, 'level', 20);
  IF v_level IS NOT NULL AND NOT app.is_code('fin_level', v_level) THEN PERFORM app.fail('MRS_INVALID', 'level'); END IF;
  v_cur := app.fin_currency(f, 'currency');
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 50);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  FOR r IN SELECT t.id, t.ref, t.branch_id, t.client_id, t.operational_status, cl.name_ar, cl.name_en
             FROM public.transactions t JOIN public.clients cl ON cl.id = t.client_id
            WHERE t.org_id = p_org AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
              AND (v_br IS NULL OR t.branch_id = v_br) AND (v_cl IS NULL OR t.client_id = v_cl)
              AND (v_from IS NULL OR (t.created_at AT TIME ZONE 'Asia/Riyadh')::date >= v_from)
              AND (v_to IS NULL OR (t.created_at AT TIME ZONE 'Asia/Riyadh')::date <= v_to)
              AND (v_ost IS NULL OR t.operational_status = v_ost)
              AND (EXISTS (SELECT 1 FROM public.cost_accruals x WHERE x.transaction_id = t.id)
                   OR EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.transaction_id = t.id)
                   OR EXISTS (SELECT 1 FROM public.client_charges ch WHERE ch.transaction_id = t.id))
            ORDER BY t.created_at DESC, t.id LOOP
    v_fig := app.fin_tx_figures(r.id);
    CONTINUE WHEN v_level IS NOT NULL AND v_fig ->> 'level' <> v_level;
    FOR c IN SELECT x FROM jsonb_array_elements(v_fig -> 'currencies') x LOOP
      CONTINUE WHEN v_cur IS NOT NULL AND c ->> 'currency' <> v_cur;
      v_items := v_items || jsonb_build_array(jsonb_build_object('transaction_id', r.id, 'ref', r.ref, 'client_id', r.client_id,
        'client_name', r.name_ar, 'client_name_en', r.name_en, 'branch_id', r.branch_id, 'operational_status', r.operational_status,
        'currency', c ->> 'currency', 'charges_service', (c ->> 'charges_service')::numeric,
        'cost_confirmed', (c ->> 'cost_confirmed')::numeric, 'cost_estimated', (c ->> 'cost_estimated')::numeric,
        'margin_confirmed', (c ->> 'margin_confirmed')::numeric, 'margin_expected', (c ->> 'margin_expected')::numeric,
        'unknown_count', (c ->> 'unknown_count')::int, 'level', v_fig ->> 'level',
        'pending_count', jsonb_array_length(v_fig -> 'pending'), 'mixed_currency', (v_fig ->> 'mixed_currency')::boolean));
    END LOOP;
  END LOOP;
  SELECT coalesce(jsonb_object_agg(t.cur, jsonb_build_object('charges_service', t.cs, 'cost_confirmed', t.cc, 'cost_estimated', t.ce,
           'margin_confirmed', t.cs - t.cc, 'margin_expected', t.cs - t.cc - t.ce, 'rows', t.n)), '{}'::jsonb)
    INTO v_totals
    FROM (SELECT i ->> 'currency' cur, sum((i ->> 'charges_service')::numeric) cs, sum((i ->> 'cost_confirmed')::numeric) cc,
                 sum((i ->> 'cost_estimated')::numeric) ce, count(*) n
            FROM jsonb_array_elements(v_items) i GROUP BY 1) t;
  RETURN jsonb_build_object('analytical', true,
    'items', coalesce((SELECT jsonb_agg(i ORDER BY o) FROM jsonb_array_elements(v_items) WITH ORDINALITY x(i, o)
                        WHERE o > v_offset AND o <= v_offset + v_limit), '[]'::jsonb),
    'total', jsonb_array_length(v_items), 'limit', v_limit, 'offset', v_offset, 'totals_by_currency', v_totals);
END $$;

-- cost_report(p_org, {group_by transaction|client|supplier|service|branch|level (required), from?, to? (item_date), branch_id?,
--   client_id?, supplier_id?, service_code?, level?, currency?, include_overhead? (true)}) — branch-scoped per item
CREATE OR REPLACE FUNCTION public.cost_report(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_g text; v_from date; v_to date; v_br uuid; v_cl uuid; v_sup uuid; v_svc text;
  v_level text; v_cur text; v_oh boolean; v_rows jsonb; v_totals jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['group_by','from','to','branch_id','client_id','supplier_id','service_code','level','currency','include_overhead']);
  v_g := app.ptext(f, 'group_by', 20, true);
  IF v_g NOT IN ('transaction','client','supplier','service','branch','level') THEN PERFORM app.fail('MRS_INVALID', 'group_by'); END IF;
  v_from := app.pdate(f, 'from'); v_to := app.pdate(f, 'to');
  v_br := app.puuid(f, 'branch_id'); v_cl := app.puuid(f, 'client_id'); v_sup := app.puuid(f, 'supplier_id');
  v_svc := app.ptext(f, 'service_code', 40); PERFORM app.fin_check_service(v_svc);
  v_level := app.ptext(f, 'level', 20);
  IF v_level IS NOT NULL AND NOT app.is_code('fin_level', v_level) THEN PERFORM app.fail('MRS_INVALID', 'level'); END IF;
  v_cur := app.fin_currency(f, 'currency');
  v_oh := coalesce(app.pbool(f, 'include_overhead'), true);
  WITH it AS (
    SELECT i.*, CASE v_g WHEN 'transaction' THEN i.transaction_id::text WHEN 'client' THEN i.client_id::text
                         WHEN 'supplier' THEN i.supplier_id::text WHEN 'service' THEN i.service_code
                         WHEN 'branch' THEN i.branch_id::text ELSE i.level END AS key
      FROM app.fin_cost_items(p_org, NULL) i
     WHERE app.has_branch_role(p_org, i.branch_id, app.fin_read_roles())
       AND (v_from IS NULL OR i.item_date >= v_from) AND (v_to IS NULL OR i.item_date <= v_to)
       AND (v_br IS NULL OR i.branch_id = v_br) AND (v_cl IS NULL OR i.client_id = v_cl)
       AND (v_sup IS NULL OR i.supplier_id = v_sup) AND (v_svc IS NULL OR i.service_code = v_svc)
       AND (v_level IS NULL OR i.level = v_level) AND (v_cur IS NULL OR i.currency = v_cur)
       AND (v_oh OR i.source <> 'overhead')),
  g AS (
    SELECT it.key, it.currency,
           round(coalesce(sum(it.amount * (1 - it.client_paid_share)) FILTER (WHERE it.level = 'confirmed' AND NOT it.is_pass_through), 0), 2) AS confirmed,
           round(coalesce(sum(it.amount * (1 - it.client_paid_share)) FILTER (WHERE it.level = 'estimated' AND NOT it.is_pass_through), 0), 2) AS estimated,
           count(*) FILTER (WHERE it.level = 'unknown')::int AS unknown_count,
           round(coalesce(sum(it.amount) FILTER (WHERE it.level = 'unknown'), 0), 2) AS unknown_amount,
           round(coalesce(sum(it.amount * (1 - it.client_paid_share)) FILTER (WHERE it.is_pass_through), 0), 2) AS pass_through,
           round(coalesce(sum(it.amount * it.client_paid_share) FILTER (WHERE it.amount IS NOT NULL), 0), 2) AS client_paid_direct,
           count(*)::int AS items
      FROM it GROUP BY it.key, it.currency)
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', g.key, 'currency', g.currency,
           'label_ar', coalesce(CASE v_g
              WHEN 'transaction' THEN (SELECT t.ref FROM public.transactions t WHERE t.id::text = g.key)
              WHEN 'client' THEN (SELECT c.name_ar FROM public.clients c WHERE c.id::text = g.key)
              WHEN 'supplier' THEN (SELECT pa.name_ar FROM public.parties pa WHERE pa.id::text = g.key)
              WHEN 'service' THEN (SELECT l.label_ar FROM public.status_labels l WHERE l.domain = 'fin_service' AND l.code = g.key)
              WHEN 'branch' THEN (SELECT b.name_ar FROM public.branches b WHERE b.id::text = g.key)
              ELSE (SELECT l.label_ar FROM public.status_labels l WHERE l.domain = 'fin_level' AND l.code = g.key) END,
              CASE WHEN g.key IS NULL THEN 'بدون تخصيص (عام / غير مخصص)' ELSE g.key END),
           'label_en', coalesce(CASE v_g
              WHEN 'transaction' THEN (SELECT t.ref FROM public.transactions t WHERE t.id::text = g.key)
              WHEN 'client' THEN (SELECT coalesce(c.name_en, c.name_ar) FROM public.clients c WHERE c.id::text = g.key)
              WHEN 'supplier' THEN (SELECT coalesce(pa.name_en, pa.name_ar) FROM public.parties pa WHERE pa.id::text = g.key)
              WHEN 'service' THEN (SELECT l.label_en FROM public.status_labels l WHERE l.domain = 'fin_service' AND l.code = g.key)
              WHEN 'branch' THEN (SELECT coalesce(b.name_en, b.name_ar) FROM public.branches b WHERE b.id::text = g.key)
              ELSE (SELECT l.label_en FROM public.status_labels l WHERE l.domain = 'fin_level' AND l.code = g.key) END,
              CASE WHEN g.key IS NULL THEN 'Not attributed (overhead / unallocated)' ELSE g.key END),
           'confirmed', g.confirmed, 'estimated', g.estimated, 'unknown_count', g.unknown_count, 'unknown_amount', g.unknown_amount,
           'pass_through', g.pass_through, 'client_paid_direct', g.client_paid_direct, 'items', g.items)
           ORDER BY g.currency, g.confirmed + g.estimated DESC, g.key NULLS LAST), '[]'::jsonb),
         coalesce((SELECT jsonb_object_agg(z.currency, jsonb_build_object('confirmed', z.c, 'estimated', z.e, 'unknown_count', z.u,
                     'unknown_amount', z.ua, 'pass_through', z.p, 'client_paid_direct', z.d))
                     FROM (SELECT g2.currency, sum(g2.confirmed) c, sum(g2.estimated) e, sum(g2.unknown_count) u, sum(g2.unknown_amount) ua,
                                  sum(g2.pass_through) p, sum(g2.client_paid_direct) d FROM g g2 GROUP BY g2.currency) z), '{}'::jsonb)
    INTO v_rows, v_totals
    FROM g;
  RETURN jsonb_build_object('group_by', v_g, 'analytical', true, 'rows', v_rows, 'totals_by_currency', v_totals);
END $$;

-- ---------------------------------------------------------------------
-- 13. readers for the UI
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fin_invoice_row(si public.supplier_invoices) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(si) || jsonb_build_object(
    'supplier_name', (SELECT pa.name_ar FROM public.parties pa WHERE pa.id = si.supplier_id),
    'supplier_name_en', (SELECT pa.name_en FROM public.parties pa WHERE pa.id = si.supplier_id),
    'line_count', (SELECT count(*) FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id),
    'pending_lines', (SELECT count(*) FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id
                        AND l.review_status IN ('pending_review','disputed')),
    'allocated_pct', (SELECT CASE WHEN coalesce(sum(l.net_amount), 0) = 0 THEN NULL
                                  ELSE round(100 * coalesce((SELECT sum(a.amount) FROM public.cost_allocations a
                                                              WHERE a.supplier_invoice_id = si.id AND a.status = 'approved'), 0)
                                             / sum(l.net_amount), 1) END
                        FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id AND l.review_status IN ('ok','pending_review','disputed')),
    'discrepancy_total', si.total_amount - coalesce((SELECT sum(l.total_amount) FROM public.supplier_invoice_lines l
                                                      WHERE l.supplier_invoice_id = si.id), 0),
    'payable_amount', app.fin_invoice_payable(si.id), 'supplier_credit_due', app.fin_invoice_credit_due(si.id))
$$;

-- list_supplier_invoices(p_org, {status?, payment_status?, supplier_id?, branch_id?, from?, to? (invoice_date), q?, needs_review?,
--   limit ≤ 200 (50), offset?})
CREATE OR REPLACE FUNCTION public.list_supplier_invoices(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_st text; v_ps text; v_sup uuid; v_br uuid; v_from date; v_to date; v_q text;
  v_nr boolean; v_limit int; v_offset int; v_items jsonb; v_total int; v_counts jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['status','payment_status','supplier_id','branch_id','from','to','q','needs_review','limit','offset']);
  v_st := app.ptext(f, 'status', 20);
  IF v_st IS NOT NULL AND NOT app.is_code('fin_invoice_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_ps := app.ptext(f, 'payment_status', 30);
  IF v_ps IS NOT NULL AND NOT app.is_code('fin_payment_status', v_ps) THEN PERFORM app.fail('MRS_INVALID', 'payment_status'); END IF;
  v_sup := app.puuid(f, 'supplier_id'); v_br := app.puuid(f, 'branch_id');
  v_from := app.pdate(f, 'from'); v_to := app.pdate(f, 'to');
  v_q := app.ptext(f, 'q', 80);
  v_nr := coalesce(app.pbool(f, 'needs_review'), false);
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 50);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  WITH base AS (
    SELECT si.* FROM public.supplier_invoices si LEFT JOIN public.parties pa ON pa.id = si.supplier_id
     WHERE si.org_id = p_org AND app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles())
       AND (v_sup IS NULL OR si.supplier_id = v_sup) AND (v_br IS NULL OR si.branch_id = v_br)
       AND (v_from IS NULL OR si.invoice_date >= v_from) AND (v_to IS NULL OR si.invoice_date <= v_to)
       AND (v_q IS NULL OR si.invoice_number ILIKE '%' || v_q || '%' OR si.number_norm = app.fin_norm_no(v_q)
            OR si.reference ILIKE '%' || v_q || '%' OR pa.name_ar ILIKE '%' || v_q || '%' OR pa.name_en ILIKE '%' || v_q || '%')
       AND (NOT v_nr OR (si.status IN ('received','under_review','disputed')
            AND (EXISTS (SELECT 1 FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id
                           AND l.review_status IN ('pending_review','disputed'))
                 OR si.total_amount <> coalesce((SELECT sum(l.total_amount) FROM public.supplier_invoice_lines l
                                                  WHERE l.supplier_invoice_id = si.id), 0))))),
  s AS (SELECT b.* FROM base b WHERE (v_st IS NULL OR b.status = v_st) AND (v_ps IS NULL OR b.payment_status = v_ps))
  SELECT (SELECT coalesce(jsonb_agg(app.fin_invoice_row(p) ORDER BY p.invoice_date DESC, p.created_at DESC, p.id), '[]'::jsonb)
            FROM (SELECT s.* FROM s ORDER BY s.invoice_date DESC, s.created_at DESC, s.id LIMIT v_limit OFFSET v_offset) p),
         (SELECT count(*) FROM s),
         jsonb_build_object(
           'by_status', (SELECT coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) FROM (SELECT b.status, count(*) n FROM base b GROUP BY 1) x),
           'by_payment_status', (SELECT coalesce(jsonb_object_agg(x.payment_status, x.n), '{}'::jsonb)
                                   FROM (SELECT b.payment_status, count(*) n FROM base b WHERE b.status <> 'void' GROUP BY 1) x))
    INTO v_items, v_total, v_counts;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'counts', v_counts, 'limit', v_limit, 'offset', v_offset);
END $$;

-- get_supplier_invoice(p_id) → {invoice, supplier, lines[+allocations], payments, adjustments, discrepancy, possible_duplicates, can}
CREATE OR REPLACE FUNCTION public.get_supplier_invoice(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE si public.supplier_invoices; v_write boolean; v_appr boolean; v_doc jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO si FROM public.supplier_invoices x WHERE x.id = p_id;
  IF si.id IS NULL OR NOT app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'supplier_invoice');
  END IF;
  v_write := app.has_branch_role(si.org_id, si.branch_id, app.fin_write_roles());
  v_appr := app.has_branch_role(si.org_id, si.branch_id, app.fin_approve_roles());
  SELECT jsonb_build_object('id', f.id, 'storage_bucket', f.storage_bucket, 'storage_path', f.storage_path, 'original_name', f.original_name,
                            'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'voided_at', f.voided_at)
    INTO v_doc FROM public.finance_documents f WHERE f.id = si.finance_document_id;
  RETURN jsonb_build_object(
    'invoice', app.fin_invoice_row(si) || jsonb_build_object('finance_document', v_doc),
    'supplier', (SELECT jsonb_build_object('id', pa.id, 'name_ar', pa.name_ar, 'name_en', pa.name_en, 'kinds', to_jsonb(pa.kinds),
                   'vat_number', pa.vat_number, 'cr_number', pa.cr_number, 'iban_last4', pa.iban_last4, 'bank_name', pa.bank_name,
                   'payment_terms_days', pa.payment_terms_days, 'default_currency', pa.default_currency)
                   FROM public.parties pa WHERE pa.id = si.supplier_id),
    'lines', coalesce((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object(
                 'allocated_approved', coalesce((SELECT sum(a.amount) FROM public.cost_allocations a WHERE a.line_id = l.id AND a.status = 'approved'), 0),
                 'allocated_proposed', coalesce((SELECT sum(a.amount) FROM public.cost_allocations a WHERE a.line_id = l.id AND a.status = 'proposed'), 0),
                 'remaining', l.net_amount - coalesce((SELECT sum(a.amount) FROM public.cost_allocations a WHERE a.line_id = l.id
                                                        AND a.status IN ('proposed','approved')), 0),
                 'allocations', coalesce((SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('ref', t.ref,
                                   'can_read_transaction', app.has_tx_role(a.transaction_id, app.fin_read_roles()),
                                   'branch_id', t.branch_id, 'transaction_branch_id', t.branch_id,
                                   'can_approve', app.fin_can_decide(t.org_id, t.branch_id, a.created_by))
                                   ORDER BY a.created_at, a.id)
                                   FROM public.cost_allocations a JOIN public.transactions t ON t.id = a.transaction_id
                                  WHERE a.line_id = l.id), '[]'::jsonb)) ORDER BY l.line_no)
                 FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id), '[]'::jsonb),
    'payments', coalesce((SELECT jsonb_agg(to_jsonb(sp) || jsonb_build_object('evidence_path', app.fin_doc_path(sp.evidence_document_id))
                                    ORDER BY sp.paid_at, sp.created_at) FROM public.supplier_payments sp
                           WHERE sp.supplier_invoice_id = si.id), '[]'::jsonb),
    -- adjustments on this invoice, and duplicates pointing at it — each under its own read rule (RLS / list_cost_adjustments)
    'adjustments', coalesce((SELECT jsonb_agg(to_jsonb(j) || jsonb_build_object(
                               'branch_id', coalesce((SELECT t.branch_id FROM public.transactions t WHERE t.id = j.transaction_id),
                                                     (SELECT x.branch_id FROM public.supplier_invoices x WHERE x.id = j.supplier_invoice_id)),
                               'can_review', (j.transaction_id IS NULL OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = j.transaction_id
                                                AND app.fin_can_decide(t.org_id, t.branch_id, j.created_by)))
                                         AND (j.supplier_invoice_id IS NULL OR EXISTS (SELECT 1 FROM public.supplier_invoices x WHERE x.id = j.supplier_invoice_id
                                                AND app.fin_can_decide(x.org_id, x.branch_id, j.created_by))))
                               ORDER BY j.created_at) FROM public.cost_adjustments j
                              WHERE (j.supplier_invoice_id = si.id OR j.related_invoice_id = si.id)
                                AND app.fin_can_read_adjustment(j.transaction_id, j.supplier_invoice_id)), '[]'::jsonb),
    'supplier_credit_due', app.fin_invoice_credit_due(si.id),
    'payable_amount', app.fin_invoice_payable(si.id),
    'discrepancy', app.fin_invoice_discrepancy(si.id),
    'possible_duplicates', app.fin_possible_duplicates(si.org_id, si.supplier_id, si.number_norm, si.invoice_date, si.total_amount,
                                                       app.fin_invoice_sha(si), si.id),
    'can', jsonb_build_object(
      'edit', v_write AND si.status IN ('received','under_review','disputed'),
      'approve', v_appr AND si.status = 'under_review' AND (si.created_by IS DISTINCT FROM auth.uid() OR app.has_role(si.org_id, ARRAY['admin'])),
      'pay', v_write AND si.status <> 'void' AND si.doc_type <> 'credit_note' AND si.payment_status NOT IN ('paid','paid_directly_by_client'),
      'void', v_appr AND si.status <> 'void'));
END $$;

-- cost_review_queue(p_org, {branch_id?, kind? lines|discrepancy|allocations|accruals|adjustments})
CREATE OR REPLACE FUNCTION public.cost_review_queue(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_kind text; v_lines jsonb; v_disc jsonb; v_alloc jsonb; v_acc jsonb; v_adj jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['branch_id','kind']);
  v_br := app.puuid(f, 'branch_id');
  v_kind := app.ptext(f, 'kind', 20);
  IF v_kind IS NOT NULL AND v_kind NOT IN ('lines','discrepancy','allocations','accruals','adjustments') THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  IF v_kind IS NULL OR v_kind = 'lines' THEN
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.st, x.d, x.no), '[]'::jsonb) INTO v_lines FROM (
      SELECT to_jsonb(l) || jsonb_build_object('invoice_number', si.invoice_number, 'invoice_status', si.status, 'branch_id', si.branch_id,
               'supplier_name', pa.name_ar, 'currency', si.currency) j,
             CASE l.review_status WHEN 'disputed' THEN 0 ELSE 1 END st, si.invoice_date d, l.line_no no
        FROM public.supplier_invoice_lines l JOIN public.supplier_invoices si ON si.id = l.supplier_invoice_id
        JOIN public.parties pa ON pa.id = si.supplier_id
       WHERE si.org_id = p_org AND si.status <> 'void' AND l.review_status IN ('pending_review','disputed')
         AND app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()) AND (v_br IS NULL OR si.branch_id = v_br)
       LIMIT 200) x;
  END IF;
  IF v_kind IS NULL OR v_kind = 'discrepancy' THEN
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.d), '[]'::jsonb) INTO v_disc FROM (
      SELECT app.fin_invoice_row(si) || jsonb_build_object('discrepancy', app.fin_invoice_discrepancy(si.id)) j, si.invoice_date d
        FROM public.supplier_invoices si
        JOIN LATERAL (SELECT count(*) n, coalesce(sum(l.net_amount), 0) net, coalesce(sum(l.vat_amount), 0) vat,
                             coalesce(sum(l.total_amount), 0) tot
                        FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id) ls ON true
       WHERE si.org_id = p_org AND si.status IN ('received','under_review','disputed')
         AND app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()) AND (v_br IS NULL OR si.branch_id = v_br)
         AND ls.n > 0 AND (si.subtotal <> ls.net OR si.vat_amount <> ls.vat OR si.total_amount <> ls.tot)
       LIMIT 200) x;
  END IF;
  IF v_kind IS NULL OR v_kind = 'allocations' THEN
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.c), '[]'::jsonb) INTO v_alloc FROM (
      SELECT to_jsonb(a) || jsonb_build_object('ref', t.ref, 'invoice_number', si.invoice_number, 'currency', si.currency,
               'supplier_name', pa.name_ar, 'line_no', l.line_no, 'line_description', l.description,
               'branch_id', t.branch_id, 'transaction_branch_id', t.branch_id,
               'can_approve', app.fin_can_decide(t.org_id, t.branch_id, a.created_by)) j, a.created_at c
        FROM public.cost_allocations a JOIN public.transactions t ON t.id = a.transaction_id
        JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id JOIN public.parties pa ON pa.id = si.supplier_id
        JOIN public.supplier_invoice_lines l ON l.id = a.line_id
       WHERE a.org_id = p_org AND a.status = 'proposed' AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
         AND (v_br IS NULL OR t.branch_id = v_br)
       LIMIT 200) x;
  END IF;
  IF v_kind IS NULL OR v_kind = 'accruals' THEN
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.c), '[]'::jsonb) INTO v_acc FROM (
      SELECT to_jsonb(ac) || jsonb_build_object('ref', t.ref, 'supplier_name', pa.name_ar, 'branch_id', t.branch_id,
               'can_review', app.has_branch_role(t.org_id, t.branch_id, app.fin_approve_roles())) j, ac.updated_at c
        FROM public.cost_accruals ac JOIN public.transactions t ON t.id = ac.transaction_id LEFT JOIN public.parties pa ON pa.id = ac.supplier_id
       WHERE ac.org_id = p_org AND ac.status = 'variance' AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
         AND (v_br IS NULL OR t.branch_id = v_br)
       LIMIT 200) x;
  END IF;
  IF v_kind IS NULL OR v_kind = 'adjustments' THEN
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.c), '[]'::jsonb) INTO v_adj FROM (
      SELECT to_jsonb(j) || jsonb_build_object('ref', t.ref, 'invoice_number', si.invoice_number,
               'branch_id', coalesce(t.branch_id, si.branch_id),
               'can_review', (t.id IS NULL OR app.fin_can_decide(t.org_id, t.branch_id, j.created_by))
                             AND (si.id IS NULL OR app.fin_can_decide(si.org_id, si.branch_id, j.created_by))) j, j.created_at c
        FROM public.cost_adjustments j LEFT JOIN public.transactions t ON t.id = j.transaction_id
        LEFT JOIN public.supplier_invoices si ON si.id = j.supplier_invoice_id
       WHERE j.org_id = p_org AND j.status = 'proposed' AND app.fin_can_read_adjustment(j.transaction_id, j.supplier_invoice_id)
         AND (v_br IS NULL OR coalesce(t.branch_id, si.branch_id) = v_br)
       LIMIT 200) x;
  END IF;
  RETURN jsonb_build_object('lines_pending', coalesce(v_lines, '[]'::jsonb), 'invoices_discrepancy', coalesce(v_disc, '[]'::jsonb),
    'allocations_proposed', coalesce(v_alloc, '[]'::jsonb), 'accruals_variance', coalesce(v_acc, '[]'::jsonb),
    'adjustments_proposed', coalesce(v_adj, '[]'::jsonb),
    'counts', jsonb_build_object('lines_pending', jsonb_array_length(coalesce(v_lines, '[]'::jsonb)),
      'invoices_discrepancy', jsonb_array_length(coalesce(v_disc, '[]'::jsonb)),
      'allocations_proposed', jsonb_array_length(coalesce(v_alloc, '[]'::jsonb)),
      'accruals_variance', jsonb_array_length(coalesce(v_acc, '[]'::jsonb)),
      'adjustments_proposed', jsonb_array_length(coalesce(v_adj, '[]'::jsonb))));
END $$;

-- list_accruals(p_org, {transaction_id?, status?, source?, supplier_id?, limit ≤ 200 (100), offset?})
CREATE OR REPLACE FUNCTION public.list_accruals(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_tx uuid; v_st text; v_src text; v_sup uuid; v_limit int; v_offset int;
  v_items jsonb; v_total int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['transaction_id','status','source','supplier_id','limit','offset']);
  v_tx := app.puuid(f, 'transaction_id'); v_sup := app.puuid(f, 'supplier_id');
  v_st := app.ptext(f, 'status', 20);
  IF v_st IS NOT NULL AND NOT app.is_code('fin_accrual_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_src := app.ptext(f, 'source', 20);
  IF v_src IS NOT NULL AND NOT app.is_code('fin_accrual_source', v_src) THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 100);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  WITH s AS (
    SELECT ac.*, t.ref, pa.name_ar AS supplier_name, tr.leg_no
      FROM public.cost_accruals ac JOIN public.transactions t ON t.id = ac.transaction_id
      LEFT JOIN public.parties pa ON pa.id = ac.supplier_id LEFT JOIN public.transport_trips tr ON tr.id = ac.trip_id
     WHERE ac.org_id = p_org AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
       AND (v_tx IS NULL OR ac.transaction_id = v_tx) AND (v_st IS NULL OR ac.status = v_st)
       AND (v_src IS NULL OR ac.source = v_src) AND (v_sup IS NULL OR ac.supplier_id = v_sup))
  SELECT (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id), '[]'::jsonb)
            FROM (SELECT * FROM s ORDER BY s.created_at, s.id LIMIT v_limit OFFSET v_offset) p),
         (SELECT count(*) FROM s)
    INTO v_items, v_total;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
END $$;

-- list_supplier_payments(p_org, {supplier_id?, branch_id?, payer?, status?, from?, to? (paid_at), limit ≤ 200 (100), offset?})
-- totals_by_currency keeps three separate figures: due (approved, unpaid), paid by the company, paid directly by the client.
CREATE OR REPLACE FUNCTION public.list_supplier_payments(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_sup uuid; v_br uuid; v_payer text; v_st text; v_from date; v_to date;
  v_limit int; v_offset int; v_items jsonb; v_total int; v_tot jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['supplier_id','branch_id','payer','status','from','to','limit','offset']);
  v_sup := app.puuid(f, 'supplier_id'); v_br := app.puuid(f, 'branch_id');
  v_payer := app.ptext(f, 'payer', 20);
  IF v_payer IS NOT NULL AND v_payer NOT IN ('company','client') THEN PERFORM app.fail('MRS_INVALID', 'payer'); END IF;
  v_st := app.ptext(f, 'status', 20);
  IF v_st IS NOT NULL AND v_st NOT IN ('recorded','void') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_from := app.pdate(f, 'from'); v_to := app.pdate(f, 'to');
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 100);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  WITH inv AS (
    SELECT si.* FROM public.supplier_invoices si
     WHERE si.org_id = p_org AND app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles())
       AND (v_sup IS NULL OR si.supplier_id = v_sup) AND (v_br IS NULL OR si.branch_id = v_br)),
  s AS (
    SELECT sp.*, inv.invoice_number, inv.branch_id, inv.supplier_id, inv.payment_status AS invoice_payment_status, pa.name_ar AS supplier_name,
           app.fin_doc_path(sp.evidence_document_id) AS evidence_path
      FROM public.supplier_payments sp JOIN inv ON inv.id = sp.supplier_invoice_id JOIN public.parties pa ON pa.id = inv.supplier_id
     WHERE (v_payer IS NULL OR sp.payer = v_payer) AND (v_st IS NULL OR sp.status = v_st)
       AND (v_from IS NULL OR sp.paid_at >= v_from) AND (v_to IS NULL OR sp.paid_at <= v_to)),
  cur AS (SELECT inv.currency::text c FROM inv UNION SELECT s.currency::text FROM s)
  SELECT (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.paid_at DESC, p.created_at DESC), '[]'::jsonb)
            FROM (SELECT * FROM s ORDER BY s.paid_at DESC, s.created_at DESC LIMIT v_limit OFFSET v_offset) p),
         (SELECT count(*) FROM s),
         (SELECT coalesce(jsonb_object_agg(cur.c, jsonb_build_object(
             -- payable = total − approved credit notes against it (debit notes stay their own payable rows)
             'due_approved_unpaid', coalesce((SELECT sum(greatest(app.fin_invoice_payable(inv.id) - inv.company_paid_amount - inv.client_paid_amount, 0))
                                               FROM inv WHERE inv.currency::text = cur.c AND inv.status = 'approved' AND inv.doc_type <> 'credit_note'), 0),
             'supplier_credit_due', coalesce((SELECT sum(app.fin_invoice_credit_due(inv.id))
                                               FROM inv WHERE inv.currency::text = cur.c AND inv.status <> 'void' AND inv.doc_type = 'invoice'), 0),
             'paid_by_company', coalesce((SELECT sum(s.amount) FROM s WHERE s.currency::text = cur.c AND s.status = 'recorded' AND s.payer = 'company'), 0),
             'paid_by_client_direct', coalesce((SELECT sum(s.amount) FROM s WHERE s.currency::text = cur.c AND s.status = 'recorded' AND s.payer = 'client'), 0))),
             '{}'::jsonb) FROM cur)
    INTO v_items, v_total, v_tot;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'totals_by_currency', v_tot);
END $$;

-- list_client_charges(p_tx) → {items: charges + collected_amount + cost_changed}
CREATE OR REPLACE FUNCTION public.list_client_charges(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.fin_tx_read(p_tx);
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'branch_id', v_tx.branch_id,
    'items', coalesce((SELECT jsonb_agg(app.fin_charge_json(c) ORDER BY c.created_at, c.id)
    FROM public.client_charges c WHERE c.transaction_id = v_tx.id), '[]'::jsonb));
END $$;

-- suggest_client_charges(p_tx) → {trips_with_sell: trips not yet charged, reimbursable_costs: costs without a charge}
CREATE OR REPLACE FUNCTION public.suggest_client_charges(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.fin_tx_read(p_tx);
  RETURN jsonb_build_object('transaction_id', v_tx.id,
    'trips_with_sell', coalesce((SELECT jsonb_agg(jsonb_build_object('trip_id', t.id, 'leg_no', t.leg_no, 'container_id', t.container_id,
        'origin', t.origin, 'destination', t.destination, 'status', t.status, 'sell_amount', t.sell_amount, 'sell_currency', t.sell_currency)
        ORDER BY t.leg_no, t.created_at)
      FROM public.transport_trips t WHERE t.transaction_id = v_tx.id AND t.status <> 'cancelled' AND t.sell_amount IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status <> 'void'
                        AND (c.trip_id = t.id
                             OR c.accrual_id IN (SELECT x.id FROM public.cost_accruals x WHERE x.trip_id = t.id)
                             OR c.cost_allocation_id IN (SELECT a.id FROM public.cost_allocations a WHERE a.status IN ('proposed','approved')
                                  AND (a.trip_id = t.id OR a.accrual_id IN (SELECT x.id FROM public.cost_accruals x WHERE x.trip_id = t.id)))))), '[]'::jsonb),
    'reimbursable_costs', coalesce((SELECT jsonb_agg(x.j ORDER BY x.o, x.c) FROM (
        SELECT 1 o, a.created_at c, jsonb_build_object('type', 'allocation', 'cost_allocation_id', a.id, 'accrual_id', a.accrual_id,
                 'amount', a.amount, 'currency', si.currency, 'service_code', a.service_code, 'description', l.description,
                 'invoice_number', si.invoice_number, 'supplier_name', pa.name_ar, 'container_id', a.container_id,
                 'demurrage_case_id', a.demurrage_case_id, 'paid_by_client', app.fin_cost_paid_by_client(a.id, NULL)) j
          FROM public.cost_allocations a JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id
          JOIN public.supplier_invoice_lines l ON l.id = a.line_id JOIN public.parties pa ON pa.id = si.supplier_id
         WHERE a.transaction_id = v_tx.id AND a.status = 'approved' AND si.status <> 'void'
           AND NOT EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status <> 'void'
                            AND (c.cost_allocation_id = a.id OR (a.accrual_id IS NOT NULL AND c.accrual_id = a.accrual_id)
                                 OR c.trip_id = coalesce(a.trip_id, (SELECT x.trip_id FROM public.cost_accruals x WHERE x.id = a.accrual_id))))
        UNION ALL
        SELECT 2, ac.created_at, jsonb_build_object('type', 'accrual', 'accrual_id', ac.id, 'amount', ac.amount, 'currency', ac.currency,
                 'service_code', ac.service_code, 'source', ac.source, 'container_id', ac.container_id,
                 'demurrage_case_id', ac.demurrage_case_id, 'trip_id', ac.trip_id, 'paid_by_client', false)
          FROM public.cost_accruals ac
         WHERE ac.transaction_id = v_tx.id AND ac.status = 'open' AND ac.amount IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status <> 'void' AND c.accrual_id = ac.id)
           AND NOT EXISTS (SELECT 1 FROM public.client_charges c JOIN public.cost_allocations a ON a.id = c.cost_allocation_id
                            WHERE c.status <> 'void' AND a.accrual_id = ac.id)
           AND (ac.trip_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.client_charges c WHERE c.status <> 'void' AND c.trip_id = ac.trip_id))) x), '[]'::jsonb));
END $$;

-- list_demurrage(p_org, {transaction_id?, status?, kind?, operator_id?, limit ≤ 200 (100), offset?}) → items with the four figures
CREATE OR REPLACE FUNCTION public.list_demurrage(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_tx uuid; v_st text; v_kind text; v_op uuid; v_limit int; v_offset int;
  v_items jsonb; v_total int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['transaction_id','status','kind','operator_id','limit','offset']);
  v_tx := app.puuid(f, 'transaction_id'); v_op := app.puuid(f, 'operator_id');
  v_st := app.ptext(f, 'status', 20);
  IF v_st IS NOT NULL AND NOT app.is_code('fin_demurrage_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_kind := app.ptext(f, 'kind', 20);
  IF v_kind IS NOT NULL AND NOT app.is_code('fin_demurrage_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 100);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  WITH s AS (
    SELECT c, t.ref, k.container_no, pa.name_ar AS operator_name, c.created_at, c.id
      FROM public.demurrage_cases c JOIN public.transactions t ON t.id = c.transaction_id
      LEFT JOIN public.containers k ON k.id = c.container_id LEFT JOIN public.parties pa ON pa.id = c.operator_id
     WHERE c.org_id = p_org AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
       AND (v_tx IS NULL OR c.transaction_id = v_tx) AND (v_st IS NULL OR c.status = v_st)
       AND (v_kind IS NULL OR c.kind = v_kind) AND (v_op IS NULL OR c.operator_id = v_op))
  SELECT (SELECT coalesce(jsonb_agg(app.fin_case_json(p.c) || jsonb_build_object('ref', p.ref, 'container_no', p.container_no,
                   'operator_name', p.operator_name) ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
            FROM (SELECT * FROM s ORDER BY s.created_at DESC, s.id LIMIT v_limit OFFSET v_offset) p),
         (SELECT count(*) FROM s)
    INTO v_items, v_total;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
END $$;

-- list_cost_adjustments(p_org, {transaction_id?, supplier_invoice_id?, status?, kind?, limit ≤ 200 (100), offset?})
CREATE OR REPLACE FUNCTION public.list_cost_adjustments(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_tx uuid; v_si uuid; v_st text; v_kind text; v_limit int; v_offset int;
  v_items jsonb; v_total int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['transaction_id','supplier_invoice_id','status','kind','limit','offset']);
  v_tx := app.puuid(f, 'transaction_id'); v_si := app.puuid(f, 'supplier_invoice_id');
  v_st := app.ptext(f, 'status', 20);
  IF v_st IS NOT NULL AND NOT app.is_code('fin_adjustment_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_kind := app.ptext(f, 'kind', 30);
  IF v_kind IS NOT NULL AND NOT app.is_code('fin_adjustment_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_limit := coalesce(app.pnum(f, 'limit', 200)::int, 100);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  WITH s AS (
    SELECT j.*, t.ref, si.invoice_number
      FROM public.cost_adjustments j LEFT JOIN public.transactions t ON t.id = j.transaction_id
      LEFT JOIN public.supplier_invoices si ON si.id = j.supplier_invoice_id
     WHERE j.org_id = p_org AND app.fin_can_read_adjustment(j.transaction_id, j.supplier_invoice_id)
       AND (v_tx IS NULL OR j.transaction_id = v_tx) AND (v_si IS NULL OR j.supplier_invoice_id = v_si OR j.related_invoice_id = v_si)
       AND (v_st IS NULL OR j.status = v_st) AND (v_kind IS NULL OR j.kind = v_kind))
  SELECT (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
            FROM (SELECT * FROM s ORDER BY s.created_at DESC, s.id LIMIT v_limit OFFSET v_offset) p),
         (SELECT count(*) FROM s)
    INTO v_items, v_total;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
END $$;

-- tx_costs(p_tx) — one call for the transaction section
CREATE OR REPLACE FUNCTION public.tx_costs(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.fin_tx_read(p_tx);
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'branch_id', v_tx.branch_id,
    'allocations', coalesce((SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('invoice_number', si.invoice_number,
        'supplier_name', pa.name_ar, 'line_description', l.description, 'line_no', l.line_no, 'invoice_status', si.status,
        'currency', si.currency, 'can_read_invoice', app.fin_can_read_invoice(si.id),
        'branch_id', v_tx.branch_id, 'can_approve', app.fin_can_decide(v_tx.org_id, v_tx.branch_id, a.created_by)) ORDER BY a.created_at, a.id)
      FROM public.cost_allocations a JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id
      JOIN public.supplier_invoice_lines l ON l.id = a.line_id JOIN public.parties pa ON pa.id = si.supplier_id
     WHERE a.transaction_id = v_tx.id), '[]'::jsonb),
    'accruals', coalesce((SELECT jsonb_agg(to_jsonb(ac) || jsonb_build_object('supplier_name', pa.name_ar, 'leg_no', tr.leg_no)
        ORDER BY ac.created_at, ac.id)
      FROM public.cost_accruals ac LEFT JOIN public.parties pa ON pa.id = ac.supplier_id
      LEFT JOIN public.transport_trips tr ON tr.id = ac.trip_id WHERE ac.transaction_id = v_tx.id), '[]'::jsonb),
    'adjustments', coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at, j.id) FROM public.cost_adjustments j
     WHERE j.transaction_id = v_tx.id), '[]'::jsonb),
    'demurrage', coalesce((SELECT jsonb_agg(app.fin_case_json(c) ORDER BY c.created_at, c.id) FROM public.demurrage_cases c
     WHERE c.transaction_id = v_tx.id), '[]'::jsonb),
    'charges', coalesce((SELECT jsonb_agg(app.fin_charge_json(c) ORDER BY c.created_at, c.id) FROM public.client_charges c
     WHERE c.transaction_id = v_tx.id), '[]'::jsonb),
    'collections', coalesce((SELECT jsonb_agg(to_jsonb(k) || jsonb_build_object('evidence_path', app.fin_doc_path(k.evidence_document_id))
                                       ORDER BY k.created_at, k.id) FROM public.charge_collections k
     WHERE k.transaction_id = v_tx.id), '[]'::jsonb),
    'trips', coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'leg_no', t.leg_no, 'container_id', t.container_id,
        'status', t.status, 'carrier_id', t.carrier_id) ORDER BY t.leg_no, t.created_at)
      FROM public.transport_trips t WHERE t.transaction_id = v_tx.id), '[]'::jsonb),
    'containers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'container_no', k.container_no) ORDER BY k.container_no)
      FROM public.containers k WHERE k.transaction_id = v_tx.id), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------
-- generic triggers (updated_at, audit, no delete on evidence)
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_invoices','supplier_invoice_lines','cost_allocations','cost_accruals','client_charges',
                           'demurrage_cases','cost_adjustments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['finance_documents','supplier_invoices','supplier_invoice_lines','cost_allocations','cost_accruals',
                           'supplier_payments','client_charges','charge_collections','demurrage_cases','cost_adjustments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
  -- payment / collection evidence: append-only (recorded → void only, never deleted)
  FOREACH t IN ARRAY ARRAY['supplier_payments','charge_collections'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_append_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_append_only BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_append_only()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- RLS, policies, grants — finance read roles only (branch scope through the transaction or the invoice);
-- clients: no policy at all. No direct writes (RPCs only), no DELETE anywhere.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_documents','supplier_invoices','supplier_invoice_lines','cost_allocations','cost_accruals',
                           'supplier_payments','client_charges','charge_collections','demurrage_cases','cost_adjustments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['finance_documents','supplier_invoices','supplier_invoice_lines','cost_allocations',
  'cost_accruals','supplier_payments','client_charges','charge_collections','demurrage_cases','cost_adjustments']) t;

CREATE POLICY finance_documents_select ON public.finance_documents FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.fin_read_roles()));
CREATE POLICY supplier_invoices_select ON public.supplier_invoices FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.fin_read_roles()));
CREATE POLICY supplier_invoice_lines_select ON public.supplier_invoice_lines FOR SELECT TO authenticated
  USING (app.fin_can_read_invoice(supplier_invoice_id));
CREATE POLICY cost_allocations_select ON public.cost_allocations FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()) OR app.fin_can_read_invoice(supplier_invoice_id));
CREATE POLICY cost_accruals_select ON public.cost_accruals FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY supplier_payments_select ON public.supplier_payments FOR SELECT TO authenticated
  USING (app.fin_can_read_invoice(supplier_invoice_id));
CREATE POLICY client_charges_select ON public.client_charges FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY charge_collections_select ON public.charge_collections FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY demurrage_cases_select ON public.demurrage_cases FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));
CREATE POLICY cost_adjustments_select ON public.cost_adjustments FOR SELECT TO authenticated
  USING ((transaction_id IS NOT NULL AND app.has_tx_role(transaction_id, app.fin_read_roles()))
         OR (supplier_invoice_id IS NOT NULL AND app.fin_can_read_invoice(supplier_invoice_id)));

-- ---------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.fin_read_roles(), app.fin_write_roles(), app.fin_approve_roles(), app.fin_fail(text, text, text),
  app.fin_check_service(text), app.fin_money(jsonb, text), app.fin_currency(jsonb, text), app.fin_note(text, text, int),
  app.fin_norm_no(text), app.fin_event(uuid, uuid, text, text, uuid, text, text, jsonb), app.fin_tx_read(uuid),
  app.fin_org_read(uuid), app.fin_four_eyes(uuid, uuid), app.tg_parties_fin_guard(), app.fin_mime_types(),
  app.fin_can_read_invoice(uuid), app.tg_supplier_invoices_before(), app.fin_invoice_discrepancy(uuid),
  app.fin_possible_duplicates(uuid, uuid, text, date, numeric, text, uuid), app.fin_invoice_sha(public.supplier_invoices),
  app.fin_lock_invoice(uuid, text[]), app.fin_invoice_editable(public.supplier_invoices),
  app.fin_check_findoc(uuid, uuid, uuid, text), app.fin_check_txdoc(uuid, uuid, text),
  app.fin_unreadable(), app.fin_line_review_reasons(public.supplier_invoice_lines), app.tg_invoice_lines_review(),
  app.fin_line_fields(jsonb, boolean, public.supplier_invoice_lines),
  app.fin_insert_lines(public.supplier_invoices, jsonb, text), app.fin_invoice_fields(jsonb, uuid, uuid),
  app.fin_amounts(numeric, numeric, numeric), app.fin_number_check(uuid, uuid, text, text, uuid),
  app.fin_void_invoice(public.supplier_invoices, text, uuid), app.fin_lock_line(uuid, text[]),
  app.fin_rematch_accrual(uuid, text, boolean), app.sync_trip_accrual(public.transport_trips), app.tg_trip_accrual(),
  app.fin_case_service(text), app.sync_demurrage_accrual(public.demurrage_cases), app.tg_demurrage_accrual(),
  app.tg_alloc_cap(), app.tg_alloc_guard(), app.fin_live_accrual(uuid, uuid), app.fin_lock_alloc_txs(uuid[], text[]),
  app.fin_payment_recompute(uuid), app.tg_payment_totals(), app.tg_client_charges_price(),
  app.fin_cost_paid_by_client(uuid, uuid), app.fin_charge_cost(public.client_charges), app.fin_charge_json(public.client_charges),
  app.tg_collection_check(), app.fin_demurrage_figures(uuid), app.fin_case_json(public.demurrage_cases),
  app.fin_case_fields(jsonb, public.transactions), app.fin_can_read_adjustment(uuid, uuid),
  app.fin_cost_items(uuid, uuid), app.fin_tx_currency_rows(uuid, uuid), app.fin_tx_pending(uuid), app.fin_tx_figures(uuid),
  app.fin_invoice_row(public.supplier_invoices), app.fin_can_decide(uuid, uuid, uuid), app.fin_doc_path(uuid),
  app.fin_invoice_payable(uuid), app.fin_invoice_credit_due(uuid), app.fin_client_share(uuid, uuid),
  app.fin_check_credit_cap(uuid, uuid, text, numeric, text),
  app.fin_check_credit_target(public.supplier_invoices, uuid, numeric, uuid, boolean)
FROM PUBLIC, anon, authenticated;
-- policy helpers (RLS runs them as the caller)
GRANT EXECUTE ON FUNCTION app.fin_read_roles(), app.fin_can_read_invoice(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION
  public.save_party_finance(uuid, jsonb), public.register_finance_document(jsonb, uuid), public.void_finance_document(uuid, text),
  public.create_supplier_invoice(jsonb, uuid), public.update_supplier_invoice(uuid, jsonb), public.set_supplier_invoice_status(uuid, text, text),
  public.check_supplier_invoice_duplicate(uuid, jsonb), public.add_invoice_lines(uuid, jsonb, text, uuid),
  public.update_invoice_line(uuid, jsonb), public.review_invoice_line(uuid, text, text, text),
  public.allocate_invoice_line(uuid, jsonb, uuid), public.approve_allocations(uuid[], text), public.reject_allocation(uuid, text),
  public.reverse_allocation(uuid, text), public.cost_review_queue(uuid, jsonb), public.list_supplier_invoices(uuid, jsonb),
  public.get_supplier_invoice(uuid), public.create_accrual(jsonb, uuid), public.review_accrual_variance(uuid, text, text),
  public.void_accrual(uuid, text), public.list_accruals(uuid, jsonb), public.record_supplier_payment(jsonb, uuid),
  public.void_supplier_payment(uuid, text), public.list_supplier_payments(uuid, jsonb), public.create_client_charge(jsonb, uuid),
  public.update_client_charge(uuid, jsonb), public.set_charge_status(uuid, text, text), public.list_client_charges(uuid),
  public.suggest_client_charges(uuid), public.record_charge_collection(jsonb, uuid), public.void_charge_collection(uuid, text),
  public.create_demurrage_case(jsonb, uuid), public.update_demurrage_case(uuid, jsonb), public.set_demurrage_status(uuid, text, text),
  public.list_demurrage(uuid, jsonb), public.create_cost_adjustment(jsonb, uuid), public.review_cost_adjustment(uuid, text, text),
  public.list_cost_adjustments(uuid, jsonb), public.tx_costs(uuid), public.tx_margin(uuid), public.margin_report(uuid, jsonb),
  public.cost_report(uuid, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.save_party_finance(uuid, jsonb), public.register_finance_document(jsonb, uuid), public.void_finance_document(uuid, text),
  public.create_supplier_invoice(jsonb, uuid), public.update_supplier_invoice(uuid, jsonb), public.set_supplier_invoice_status(uuid, text, text),
  public.check_supplier_invoice_duplicate(uuid, jsonb), public.add_invoice_lines(uuid, jsonb, text, uuid),
  public.update_invoice_line(uuid, jsonb), public.review_invoice_line(uuid, text, text, text),
  public.allocate_invoice_line(uuid, jsonb, uuid), public.approve_allocations(uuid[], text), public.reject_allocation(uuid, text),
  public.reverse_allocation(uuid, text), public.cost_review_queue(uuid, jsonb), public.list_supplier_invoices(uuid, jsonb),
  public.get_supplier_invoice(uuid), public.create_accrual(jsonb, uuid), public.review_accrual_variance(uuid, text, text),
  public.void_accrual(uuid, text), public.list_accruals(uuid, jsonb), public.record_supplier_payment(jsonb, uuid),
  public.void_supplier_payment(uuid, text), public.list_supplier_payments(uuid, jsonb), public.create_client_charge(jsonb, uuid),
  public.update_client_charge(uuid, jsonb), public.set_charge_status(uuid, text, text), public.list_client_charges(uuid),
  public.suggest_client_charges(uuid), public.record_charge_collection(jsonb, uuid), public.void_charge_collection(uuid, text),
  public.create_demurrage_case(jsonb, uuid), public.update_demurrage_case(uuid, jsonb), public.set_demurrage_status(uuid, text, text),
  public.list_demurrage(uuid, jsonb), public.create_cost_adjustment(jsonb, uuid), public.review_cost_adjustment(uuid, text, text),
  public.list_cost_adjustments(uuid, jsonb), public.tx_costs(uuid), public.tx_margin(uuid), public.margin_report(uuid, jsonb),
  public.cost_report(uuid, jsonb)
TO authenticated;

