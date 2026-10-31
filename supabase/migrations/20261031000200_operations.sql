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
