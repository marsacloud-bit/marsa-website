-- Marsa staging: all migrations in order (generated from supabase/migrations). Paste into Supabase SQL Editor and Run.
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
