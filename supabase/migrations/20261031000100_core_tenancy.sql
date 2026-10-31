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
