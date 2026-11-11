-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261122000100 — legacy port, step 6: payments, disbursements and client custody
-- (السدادات والمصروفات وعهدة العملاء) — docs/online/LEGACY_PAY_AR.md, plan docs/online/LEGACY_PORT_PLAN_AR.md
-- («السدادات وعهدة العملاء»). Builds on legacy_appt (20261121000100), the G4 costs (20261104000100: supplier_invoices,
-- supplier_payments, client_charges, finance_documents, the finance roles) and step 1 (fin_funding_source,
-- the Saudi payment methods, org_service_items, app.norm_tas, app.fin_funding_check).
--   P. preflight (legacy_appt applied; record_supplier_payment / fin_funding_check / norm_tas present) + schema_versions row
--   0. dictionaries status_labels: pay_movement_type, pay_pattern, pay_review_status, pay_status, pay_document_role,
--                   custody_entry_kind, custody_entry_status
--   1. columns      supplier_invoices + internal_invoice_no (unique per org among non-void invoices, the Fasah FP… number),
--                   created_by_disbursement_id; supplier_payments + disbursement_allocation_id (the register line it books)
--   2. tables       public.client_disbursements (the unified register: movement type, pattern, service item, claim no,
--                   appointment no TAS, expected / paid / difference, date, funding source, method, paying account, payer,
--                   beneficiary = the invoice issuer, channel, SADAD no / bank ref / receipt, review draft / pending /
--                   approved / rejected, recorded → void, corrections chain), public.disbursement_allocations (the share of
--                   each transaction / invoice; single = one line, shared = ≥ 2 lines, Σ = paid), public.payment_documents
--                   (typed attachments: entity_invoice / payment_proof / extra, per allocation in shared mode, soft removal),
--                   public.client_custody_entries (deposit / deduction / refund, active → void, balance never negative),
--                   view public.client_custody_balances (security invoker: the caller's branches)
--   3. helpers      app.pay_ref_norm, app.pay_inv_key, app.pay_int_key, app.pay_is_author, app.pay_org_payer, app.pay_can_read, app.pay_lock, app.pay_row, app.pay_detail,
--                   app.pay_ref_conflict, app.pay_locked, app.pay_void_core, app.pay_record, app.custody_balance,
--                   app.custody_lock, app.custody_json; triggers app.tg_pay_before, app.tg_pay_guard, app.tg_pay_sum (deferred),
--                   app.tg_pay_alloc_guard, app.tg_pay_doc_guard, app.tg_custody_guard, app.tg_custody_balance;
--                   app.tg_payment_totals re-created (20261104000100): a client-direct payment booked from the register
--                   (disbursement_allocation_id set) settles that client's share without a G4 cost allocation
--   4. RPCs         record_payment_bundle, correct_payment, void_payment, review_payment, add_payment_documents,
--                   remove_payment_document, get_payment, list_payments, tx_disbursements, check_payment_duplicates,
--                   match_payment_transaction; save_custody_entry, void_custody_entry, list_custody_entries,
--                   custody_balances, client_custody_balance
--   5. conversion   app.convert_delete_tables / app.convert_delete_guards re-created with the 4 new tables
--   6. RLS, grants, function privileges
-- Why a new register table and not an extension of supplier_payments: a G4 supplier payment is evidence against exactly
-- ONE supplier invoice (supplier_invoice_id NOT NULL, overpay cap, invoice payment cache). A register entry covers zero
-- invoices (money received from the client, a fee without an invoice), one, or several invoices / transactions (shared
-- payment), and carries the movement type, funding source, method references and the review state. So the register
-- lives in client_disbursements + disbursement_allocations, and every allocation that names an invoice of the beneficiary
-- BOOKS one G4 supplier_payments row (payer company for org_paid, client for client_direct) linked by
-- disbursement_allocation_id: G4 keeps its invoice payment status, overpay check and margin figures unchanged.
-- Owner decisions: the AI never verifies or approves anything (a payment-document reading only fills empty form fields;
-- a staff member saves; approval is four-eyes: the approver is never the creator, admins included); Daftra is step 7
-- (nothing is pushed; a reimbursable disbursement may create a DRAFT client_charges row when charge_client is set; a
-- payment linked to Daftra or to an invoiced charge cannot be voided or corrected). Legacy bug fixed: voiding a custody
-- deposit that would make the client balance negative is refused (re-checked under a per-client advisory lock, and by the
-- balance trigger). Wallet balances are a later phase (only the funding source is recorded). Dates are dates (no time),
-- compared with today in Asia/Riyadh.
-- Errors: + MRS_PAY_REF_TAKEN, MRS_PAY_REF_METHOD, MRS_PAY_REFERENCE, MRS_PAY_FUNDING, MRS_PAY_ALLOCATION, MRS_PAY_DOCUMENT,
-- MRS_PAY_INVOICE_TAKEN, MRS_CONFIRM_INVOICE_REUSE, MRS_PAY_LOCKED, MRS_CUSTODY_NEGATIVE, MRS_CUSTODY_LINK; otherwise existing
-- codes (MRS_REQUIRED, MRS_INVALID, MRS_FORBIDDEN 'self_approval', MRS_BAD_TRANSITION, MRS_NOTE_REQUIRED, MRS_OVERPAID …).
-- Re-runnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS + CREATE /
-- ON CONFLICT). Re-pasting 20261104000100 (G4) after this file restores the G4 client-direct check (a register
-- client-direct payment can then not be booked) and narrows nothing else; re-pasting 20261115000100 / 20261116000100 /
-- 20261117000100 / 20261119000100 / 20261120000100 / 20261121000100 drops the 4 tables from the conversion lists (the
-- conversion then refuses: unclassified_tables): re-paste this file right after.
-- Down-path (staging only): DROP the RPCs of §4 and the app.* helpers / triggers of §3; DROP VIEW
-- public.client_custody_balances; DROP TABLE public.client_custody_entries, public.payment_documents,
-- public.disbursement_allocations, public.client_disbursements; DROP the columns of §1; re-paste 20261104000100
-- (tg_payment_totals) and 20261121000100 §6.
-- =====================================================================

DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261121000100') THEN
    RAISE EXCEPTION 'LEGACY PAY preflight: apply legacy_appt first (schema_versions lacks 20261121000100 legacy_appt)';
  END IF;
  IF to_regprocedure('public.record_supplier_payment(jsonb,uuid)') IS NULL
     OR to_regprocedure('app.fin_funding_check(text,text,text,text,boolean)') IS NULL
     OR to_regprocedure('app.norm_tas(text)') IS NULL OR to_regclass('public.org_service_items') IS NULL THEN
    RAISE EXCEPTION 'LEGACY PAY preflight: G4 payments / step 1 finance helpers missing (apply 20261104000100 / 20261117000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261122000100', 'legacy_pay')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('pay_movement_type','org_paid',1,'دفعت المؤسسة عن العميل','Organization paid for the client',false),
  ('pay_movement_type','received_from_client',2,'استلمت المؤسسة من العميل','Organization received from the client',false),
  ('pay_movement_type','client_direct',3,'دفع العميل للجهة مباشرة','Client paid the entity directly',false),
  ('pay_pattern','single',1,'فردي','Single',false),
  ('pay_pattern','shared',2,'مشترك','Shared',false),
  ('pay_review_status','draft',1,'مسودة','Draft',false),
  ('pay_review_status','pending',2,'بانتظار المراجعة','Pending review',false),
  ('pay_review_status','approved',3,'معتمد','Approved',false),
  ('pay_review_status','rejected',4,'مرفوض','Rejected',false),
  ('pay_status','recorded',1,'مسجل','Recorded',false),
  ('pay_status','void',2,'ملغى','Void',false),
  ('pay_document_role','entity_invoice',1,'فاتورة الجهة','Entity invoice',false),
  ('pay_document_role','payment_proof',2,'إثبات السداد','Payment proof',false),
  ('pay_document_role','extra',3,'مرفق إضافي','Extra attachment',false),
  ('custody_entry_kind','deposit',1,'إيداع عهدة','Custody deposit',false),
  ('custody_entry_kind','deduction',2,'خصم من العهدة','Custody deduction',false),
  ('custody_entry_kind','refund',3,'إرجاع عهدة','Custody refund',false),
  ('custody_entry_status','active',1,'نشط','Active',false),
  ('custody_entry_status','void',2,'ملغى','Void',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. columns on the G4 tables (no grant change: finance readers already SELECT the whole rows)
-- ---------------------------------------------------------------------
ALTER TABLE public.supplier_invoices ADD COLUMN IF NOT EXISTS internal_invoice_no text
  CHECK (char_length(internal_invoice_no) BETWEEN 1 AND 60);
ALTER TABLE public.supplier_invoices ADD COLUMN IF NOT EXISTS created_by_disbursement_id uuid;
-- the internal (Fasah FP…) invoice number is unique among the org's non-void invoices (letters / digits compared)
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_internal_no_uidx ON public.supplier_invoices
  (org_id, upper(regexp_replace(internal_invoice_no, '[^A-Za-z0-9]', '', 'g')))
  WHERE status <> 'void' AND internal_invoice_no IS NOT NULL;
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS disbursement_allocation_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_disb_alloc_uidx ON public.supplier_payments (disbursement_allocation_id)
  WHERE disbursement_allocation_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. tables
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.client_disbursements_seq;
CREATE SEQUENCE IF NOT EXISTS public.client_custody_entries_seq;

CREATE TABLE IF NOT EXISTS public.client_disbursements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL,
  seq                  bigint NOT NULL DEFAULT nextval('public.client_disbursements_seq'),
  ref                  text NOT NULL CHECK (ref ~ '^PAY-[0-9]{6,}$'),
  movement_type        text NOT NULL CHECK (movement_type IN ('org_paid','received_from_client','client_direct')),
  pattern              text NOT NULL CHECK (pattern IN ('single','shared')),
  service_item_id      uuid NOT NULL,
  service_code         text NOT NULL CHECK (char_length(service_code) BETWEEN 2 AND 40),
  fin_service          text,
  claim_no             text CHECK (char_length(claim_no) BETWEEN 1 AND 60),
  appointment_no       text CHECK (appointment_no ~ '^TAS[0-9]{8,}$' AND char_length(appointment_no) <= 40),
  currency             char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  expected_amount      numeric(14,2) NOT NULL CHECK (expected_amount >= 0),
  paid_amount          numeric(14,2) NOT NULL CHECK (paid_amount > 0),
  difference           numeric(14,2) GENERATED ALWAYS AS (expected_amount - paid_amount) STORED,
  paid_at              date NOT NULL,
  funding_source       text NOT NULL,
  method               text NOT NULL CHECK (method IN ('sadad','mada','fasah_wallet','dry_port_wallet','bank_transfer','cash','cheque','other')),
  paying_account       text CHECK (char_length(paying_account) BETWEEN 1 AND 120),
  payer_name           text NOT NULL CHECK (char_length(payer_name) BETWEEN 1 AND 160),
  beneficiary_party_id uuid,
  beneficiary_name     text NOT NULL CHECK (char_length(beneficiary_name) BETWEEN 1 AND 160),
  payment_channel      text CHECK (char_length(payment_channel) BETWEEN 1 AND 60),
  sadad_number         text CHECK (sadad_number ~ '^[0-9]{1,30}$'),
  bank_reference       text CHECK (bank_reference ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' AND char_length(bank_reference) <= 60),
  receipt_no           text CHECK (char_length(receipt_no) BETWEEN 1 AND 100),
  bank_ref_norm        text,
  receipt_norm         text,
  review_status        text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('draft','pending','approved','rejected')),
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_note          text CHECK (char_length(review_note) <= 2000),
  status               text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','void')),
  void_reason          text CHECK (char_length(void_reason) <= 2000),
  voided_by            uuid,
  voided_at            timestamptz,
  corrects_id          uuid,
  corrected_by_id      uuid,
  original_created_by  uuid,
  charge_client        boolean NOT NULL DEFAULT false,
  notes                text CHECK (char_length(notes) <= 2000),
  daftra_draft_id      text CHECK (char_length(daftra_draft_id) <= 60),    -- step 7 (Daftra); never written in this step
  daftra_linked_at     timestamptz,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_disbursements_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT client_disbursements_item_fk FOREIGN KEY (service_item_id, org_id) REFERENCES public.org_service_items(id, org_id),
  CONSTRAINT client_disbursements_benef_fk FOREIGN KEY (beneficiary_party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT client_disbursements_ref_uniq UNIQUE (ref),
  -- the movement decides the funding source (legacy normalizePaymentFundingSource_)
  CONSTRAINT client_disbursements_movement_chk CHECK (
    CASE movement_type WHEN 'client_direct' THEN funding_source = 'client_direct'
                       WHEN 'received_from_client' THEN funding_source = 'not_applicable_receipt'
                       ELSE funding_source IN ('org_account','cash_box','fasah_wallet','dry_port_wallet_org','client_custody',
                                               'client_custody_dry_port','personal_account') END),
  -- the funding source × method matrix (step 1: app.fin_funding_check; NULL = consistent)
  CONSTRAINT client_disbursements_matrix_chk CHECK (app.fin_funding_check(funding_source, method, payer_name, paying_account, false) IS NULL),
  -- the beneficiary is the invoice issuer (a party), except money received by the organization itself
  CONSTRAINT client_disbursements_benef_chk CHECK ((movement_type = 'received_from_client') = (beneficiary_party_id IS NULL)),
  -- one reference column per method (legacy validatePaymentMethodReferences_); wallets: any or the proof file
  CONSTRAINT client_disbursements_refs_chk CHECK (CASE
    WHEN method = 'sadad' THEN sadad_number IS NOT NULL AND bank_reference IS NULL AND receipt_no IS NULL
    WHEN method = 'bank_transfer' THEN bank_reference IS NOT NULL AND sadad_number IS NULL AND receipt_no IS NULL
    WHEN method IN ('mada','cash','cheque','other') THEN receipt_no IS NOT NULL AND sadad_number IS NULL AND bank_reference IS NULL
    ELSE true END),
  CONSTRAINT client_disbursements_shared_chk CHECK (pattern = 'single' OR claim_no IS NULL),
  CONSTRAINT client_disbursements_void_chk CHECK ((status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT client_disbursements_review_chk CHECK ((review_status IN ('approved','rejected')) = (reviewed_by IS NOT NULL)),
  CONSTRAINT client_disbursements_corrects_chk CHECK (corrects_id IS DISTINCT FROM id AND corrected_by_id IS DISTINCT FROM id),
  UNIQUE (id, org_id)
);
ALTER TABLE public.client_disbursements DROP CONSTRAINT IF EXISTS client_disbursements_corrects_fk;
ALTER TABLE public.client_disbursements ADD CONSTRAINT client_disbursements_corrects_fk
  FOREIGN KEY (corrects_id, org_id) REFERENCES public.client_disbursements(id, org_id);
ALTER TABLE public.client_disbursements DROP CONSTRAINT IF EXISTS client_disbursements_corrected_by_fk;
ALTER TABLE public.client_disbursements ADD CONSTRAINT client_disbursements_corrected_by_fk
  FOREIGN KEY (corrected_by_id, org_id) REFERENCES public.client_disbursements(id, org_id);
COMMENT ON TABLE public.client_disbursements IS 'Legacy «السدادات» register (Payments.js savePaymentRecord): one real money movement (org paid for the client / received from the client / client paid the entity directly), single or shared over disbursement_allocations. Books G4 supplier_payments for the invoice lines. Append-only: recorded → void; a correction voids and re-records (corrects_id). Review draft / pending / approved / rejected, four-eyes. Finance roles only.';
-- global duplicate prevention of the references among recorded entries of the org (legacy assertNoDuplicatePayment_)
CREATE UNIQUE INDEX IF NOT EXISTS client_disbursements_sadad_uidx ON public.client_disbursements (org_id, sadad_number)
  WHERE status = 'recorded' AND sadad_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS client_disbursements_bank_uidx ON public.client_disbursements (org_id, bank_ref_norm)
  WHERE status = 'recorded' AND bank_ref_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS client_disbursements_receipt_uidx ON public.client_disbursements (org_id, receipt_norm)
  WHERE status = 'recorded' AND receipt_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS client_disbursements_corrects_uidx ON public.client_disbursements (corrects_id) WHERE corrects_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_disbursements_list_idx ON public.client_disbursements (org_id, branch_id, paid_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS client_disbursements_review_idx ON public.client_disbursements (org_id, review_status) WHERE status = 'recorded';

ALTER TABLE public.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_created_disb_fk;
ALTER TABLE public.supplier_invoices ADD CONSTRAINT supplier_invoices_created_disb_fk
  FOREIGN KEY (created_by_disbursement_id, org_id) REFERENCES public.client_disbursements(id, org_id);

CREATE TABLE IF NOT EXISTS public.disbursement_allocations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  disbursement_id      uuid NOT NULL,
  seq                  int NOT NULL CHECK (seq BETWEEN 1 AND 50),
  transaction_id       uuid NOT NULL,
  client_id            uuid NOT NULL,
  beneficiary_party_id uuid,
  claim_no             text CHECK (char_length(claim_no) BETWEEN 1 AND 60),
  invoice_norm         text CHECK (char_length(invoice_norm) BETWEEN 1 AND 60),
  internal_invoice_no  text CHECK (char_length(internal_invoice_no) BETWEEN 1 AND 60),
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  notes                text CHECK (char_length(notes) <= 500),
  supplier_invoice_id  uuid,
  supplier_payment_id  uuid,
  client_charge_id     uuid,
  voided_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT disbursement_allocations_disb_fk FOREIGN KEY (disbursement_id, org_id) REFERENCES public.client_disbursements(id, org_id),
  CONSTRAINT disbursement_allocations_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT disbursement_allocations_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT disbursement_allocations_si_fk FOREIGN KEY (supplier_invoice_id, org_id) REFERENCES public.supplier_invoices(id, org_id),
  CONSTRAINT disbursement_allocations_sp_fk FOREIGN KEY (supplier_payment_id, org_id) REFERENCES public.supplier_payments(id, org_id),
  CONSTRAINT disbursement_allocations_charge_fk FOREIGN KEY (client_charge_id, org_id) REFERENCES public.client_charges(id, org_id),
  CONSTRAINT disbursement_allocations_claim_chk CHECK ((claim_no IS NULL) = (invoice_norm IS NULL)),
  UNIQUE (id, org_id),
  UNIQUE (id, disbursement_id),
  UNIQUE (disbursement_id, seq)
);
COMMENT ON TABLE public.disbursement_allocations IS 'Legacy «توزيعات السدادات»: the share of one transaction (and one invoice of the beneficiary) in a register entry. A transaction shows only its share. Σ amount = the entry''s paid amount (deferred check). Voided with the entry; never deleted.';
-- no duplicate transaction + invoice inside one entry (legacy normalizePaymentAllocations_)
CREATE UNIQUE INDEX IF NOT EXISTS disbursement_allocations_tx_inv_uidx ON public.disbursement_allocations
  (disbursement_id, transaction_id, coalesce(invoice_norm, ''));
-- invoice identity: the same issuer + the same invoice number is booked once among live entries (legacy assertInvoiceIdentity_)
CREATE UNIQUE INDEX IF NOT EXISTS disbursement_allocations_identity_uidx ON public.disbursement_allocations
  (org_id, beneficiary_party_id, invoice_norm) WHERE voided_at IS NULL AND invoice_norm IS NOT NULL AND beneficiary_party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS disbursement_allocations_tx_idx ON public.disbursement_allocations (transaction_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS disbursement_allocations_norm_idx ON public.disbursement_allocations (org_id, invoice_norm) WHERE voided_at IS NULL;
ALTER TABLE public.supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_disb_alloc_fk;
ALTER TABLE public.supplier_payments ADD CONSTRAINT supplier_payments_disb_alloc_fk
  FOREIGN KEY (disbursement_allocation_id, org_id) REFERENCES public.disbursement_allocations(id, org_id);

CREATE TABLE IF NOT EXISTS public.payment_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  disbursement_id     uuid NOT NULL,
  allocation_id       uuid,
  finance_document_id uuid NOT NULL,
  role                text NOT NULL CHECK (role IN ('entity_invoice','payment_proof','extra')),
  removed_at          timestamptz,
  removed_by          uuid,
  remove_reason       text CHECK (char_length(remove_reason) <= 500),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_documents_disb_fk FOREIGN KEY (disbursement_id, org_id) REFERENCES public.client_disbursements(id, org_id),
  CONSTRAINT payment_documents_alloc_fk FOREIGN KEY (allocation_id, disbursement_id) REFERENCES public.disbursement_allocations(id, disbursement_id),
  CONSTRAINT payment_documents_doc_fk FOREIGN KEY (finance_document_id, org_id) REFERENCES public.finance_documents(id, org_id),
  CONSTRAINT payment_documents_removed_chk CHECK ((removed_at IS NULL) = (remove_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.payment_documents IS 'Legacy «مرفقات السدادات»: typed files of a register entry (entity invoice / payment proof / extra), per allocation in shared mode. The bytes are finance_documents (private bucket "finance"); removal is soft (removed_at), never a delete.';
CREATE UNIQUE INDEX IF NOT EXISTS payment_documents_live_uidx ON public.payment_documents (finance_document_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS payment_documents_disb_idx ON public.payment_documents (disbursement_id);

CREATE TABLE IF NOT EXISTS public.client_custody_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  branch_id       uuid NOT NULL,
  client_id       uuid NOT NULL,
  seq             bigint NOT NULL DEFAULT nextval('public.client_custody_entries_seq'),
  ref             text NOT NULL CHECK (ref ~ '^CUS-[0-9]{6,}$'),
  kind            text NOT NULL CHECK (kind IN ('deposit','deduction','refund')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  signed_amount   numeric(14,2) GENERATED ALWAYS AS (CASE WHEN kind = 'deposit' THEN amount ELSE -amount END) STORED,
  currency        char(3) NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  entry_date      date NOT NULL,
  transaction_id  uuid,
  disbursement_id uuid,
  reference       text CHECK (char_length(reference) <= 120),
  notes           text CHECK (char_length(notes) <= 2000),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_reason     text CHECK (char_length(btrim(void_reason)) BETWEEN 3 AND 500),
  voided_by       uuid,
  voided_at       timestamptz,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_custody_entries_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT client_custody_entries_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT client_custody_entries_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT client_custody_entries_disb_fk FOREIGN KEY (disbursement_id, org_id) REFERENCES public.client_disbursements(id, org_id),
  CONSTRAINT client_custody_entries_ref_uniq UNIQUE (ref),
  -- a deduction is linked to a transaction AND one of its payments; deposits / refunds never to a payment
  CONSTRAINT client_custody_entries_link_chk CHECK ((kind = 'deduction') = (disbursement_id IS NOT NULL)
                                                   AND (kind <> 'deduction' OR transaction_id IS NOT NULL)),
  CONSTRAINT client_custody_entries_void_chk CHECK ((status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.client_custody_entries IS 'Legacy «عهدة العملاء» (CustomerCustody.js): money a client advanced to the broker (deposit), used for one of its payments (deduction) or returned (refund). Active → void with a reason (≥ 3 chars), never deleted. The client balance (Σ signed_amount of active entries) is never negative — re-checked under a per-client advisory lock and by trg_custody_balance, also when a deposit is voided (legacy bug fixed). Finance roles only.';
-- one active deduction per client + transaction + payment (legacy custodyAssertNoDuplicatePaymentDeduction_)
CREATE UNIQUE INDEX IF NOT EXISTS client_custody_entries_deduction_uidx ON public.client_custody_entries (org_id, client_id, transaction_id, disbursement_id)
  WHERE kind = 'deduction' AND status = 'active';
CREATE INDEX IF NOT EXISTS client_custody_entries_client_idx ON public.client_custody_entries (org_id, client_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS client_custody_entries_disb_idx ON public.client_custody_entries (disbursement_id) WHERE disbursement_id IS NOT NULL;

-- per-client balances of the rows the caller can read (security invoker: RLS of client_custody_entries applies);
-- the org-wide figure of one client comes from public.client_custody_balance / public.custody_balances
CREATE OR REPLACE VIEW public.client_custody_balances WITH (security_invoker = true) AS
  SELECT e.org_id, e.client_id,
         sum(e.signed_amount)::numeric(14,2) AS balance,
         coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deposit'), 0)::numeric(14,2) AS total_deposits,
         coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deduction'), 0)::numeric(14,2) AS total_deductions,
         coalesce(sum(e.amount) FILTER (WHERE e.kind = 'refund'), 0)::numeric(14,2) AS total_refunds,
         count(*)::int AS entry_count, max(e.entry_date) AS last_entry_date
    FROM public.client_custody_entries e
   WHERE e.status = 'active'
   GROUP BY e.org_id, e.client_id;

-- ---------------------------------------------------------------------
-- 3. helpers
-- ---------------------------------------------------------------------
-- the uniqueness key of a reference (legacy normalizeUniqueBankReference_ / normalizeUniqueGeneralReference_):
-- 'bank' upper case without '-', 'receipt' upper case, separators dropped, only A-Z 0-9 and Arabic letters kept
CREATE OR REPLACE FUNCTION app.pay_ref_norm(p_kind text, p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := upper(app.to_western(btrim(coalesce(p, ''))));
BEGIN
  IF v = '' THEN RETURN NULL; END IF;
  IF p_kind = 'bank' THEN RETURN nullif(replace(v, '-', ''), ''); END IF;
  IF p_kind = 'receipt' THEN
    v := regexp_replace(v, '[[:space:]_/\\.-]+', '', 'g');
    RETURN nullif(regexp_replace(v, '[^A-Z0-9' || chr(1536) || '-' || chr(1791) || ']', '', 'g'), '');
  END IF;
  RETURN nullif(regexp_replace(v, '[^0-9]', '', 'g'), '');
END $$;

-- the identity key of an invoice number (legacy normalizeInvoiceNumber_ drops every separator): app.fin_norm_no (Arabic
-- digits → Western, upper case, leading zeros of each group, Arabic letter forms, separators) with the '-' it keeps between
-- two digit groups removed too — so 'INV-123/456', 'INV 123456' and 'INV123456' are one invoice, and whatever G4 treats
-- as one number stays one here. A G4 invoice is compared on app.pay_inv_key(invoice_number).
CREATE OR REPLACE FUNCTION app.pay_inv_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(replace(app.fin_norm_no(p), '-', ''), '')
$$;

-- the comparison key of an internal (Fasah FP…) invoice number: letters / digits only, upper case
CREATE OR REPLACE FUNCTION app.pay_int_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(upper(regexp_replace(app.to_western(coalesce(p, '')), '[^A-Za-z0-9]', '', 'g')), '')
$$;

-- four eyes across corrections: p_uid typed (created_by) or originally created (original_created_by) this entry or ANY entry
-- it corrects (the corrects_id chain) — such a user never approves / rejects it
CREATE OR REPLACE FUNCTION app.pay_is_author(p_id uuid, p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH RECURSIVE ch AS (
    SELECT d.id, d.corrects_id, d.created_by, d.original_created_by, 1 AS depth FROM public.client_disbursements d WHERE d.id = p_id
    UNION ALL
    SELECT o.id, o.corrects_id, o.created_by, o.original_created_by, ch.depth + 1 FROM public.client_disbursements o
      JOIN ch ON o.id = ch.corrects_id WHERE ch.depth < 200)
  SELECT p_uid IS NULL OR EXISTS (SELECT 1 FROM ch WHERE ch.created_by = p_uid OR ch.original_created_by = p_uid)
$$;

-- the payer name of the organization (legacy institutionName, NOT a constant): organizations.settings.payer_name, else name_ar
CREATE OR REPLACE FUNCTION app.pay_org_payer(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT left(coalesce(nullif(btrim(o.settings ->> 'payer_name'), ''), o.name_ar), 160) FROM public.organizations o WHERE o.id = p_org
$$;

-- policy helper (runs as the caller): finance read role at the entry's branch
CREATE OR REPLACE FUNCTION app.pay_can_read(p_disb uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.client_disbursements d
                  WHERE d.id = p_disb AND app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles()))
$$;

-- lock an entry the caller may read (else MRS_NOT_FOUND) with one of p_roles at its branch (else MRS_FORBIDDEN 'role')
CREATE OR REPLACE FUNCTION app.pay_lock(p_id uuid, p_roles text[]) RETURNS public.client_disbursements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.client_disbursements;
BEGIN
  SELECT * INTO v FROM public.client_disbursements d WHERE d.id = p_id FOR UPDATE;
  IF v.id IS NULL OR NOT app.has_branch_role(v.org_id, v.branch_id, app.fin_read_roles()) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'payment');
  END IF;
  IF NOT app.has_branch_role(v.org_id, v.branch_id, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  RETURN v;
END $$;

-- a list row (no allocations detail): the entry + service name + transactions + document count
CREATE OR REPLACE FUNCTION app.pay_row(d public.client_disbursements) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(d) - ARRAY['bank_ref_norm','receipt_norm'] || jsonb_build_object(
    'service_name_ar', (SELECT i.name_ar FROM public.org_service_items i WHERE i.id = d.service_item_id),
    'service_name_en', (SELECT i.name_en FROM public.org_service_items i WHERE i.id = d.service_item_id),
    'allocation_count', (SELECT count(*) FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id),
    'transactions', coalesce((SELECT jsonb_agg(jsonb_build_object('transaction_id', a.transaction_id, 'ref', t.ref, 'client_id', a.client_id,
                                     'client_name', c.name_ar, 'amount', a.amount, 'claim_no', a.claim_no) ORDER BY a.seq)
                                FROM public.disbursement_allocations a JOIN public.transactions t ON t.id = a.transaction_id
                                JOIN public.clients c ON c.id = a.client_id WHERE a.disbursement_id = d.id), '[]'::jsonb),
    'document_count', (SELECT count(*) FROM public.payment_documents x WHERE x.disbursement_id = d.id AND x.removed_at IS NULL))
$$;

-- the full entry: allocations (transaction, invoice, booked G4 payment, charge), documents (live and removed), the
-- correction chain and the linked custody deductions
CREATE OR REPLACE FUNCTION app.pay_detail(d public.client_disbursements) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.pay_row(d) || jsonb_build_object(
    'allocations', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'seq', a.seq, 'transaction_id', a.transaction_id, 'transaction_ref', t.ref, 'client_id', a.client_id,
        'client_name', c.name_ar, 'amount', a.amount, 'claim_no', a.claim_no, 'internal_invoice_no', a.internal_invoice_no, 'notes', a.notes,
        'supplier_invoice', CASE WHEN si.id IS NULL THEN NULL ELSE jsonb_build_object('id', si.id, 'invoice_number', si.invoice_number,
          'internal_invoice_no', si.internal_invoice_no, 'status', si.status, 'payment_status', si.payment_status, 'total_amount', si.total_amount,
          'invoice_date', si.invoice_date, 'vat_amount', si.vat_amount,
          'created_by_this', coalesce(si.created_by_disbursement_id = d.id, false)) END,
        'supplier_payment_id', a.supplier_payment_id,
        'client_charge', CASE WHEN ch.id IS NULL THEN NULL ELSE jsonb_build_object('id', ch.id, 'status', ch.status, 'total_amount', ch.total_amount) END,
        'voided_at', a.voided_at) ORDER BY a.seq)
      FROM public.disbursement_allocations a JOIN public.transactions t ON t.id = a.transaction_id JOIN public.clients c ON c.id = a.client_id
      LEFT JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id LEFT JOIN public.client_charges ch ON ch.id = a.client_charge_id
     WHERE a.disbursement_id = d.id), '[]'::jsonb),
    'documents', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', x.id, 'role', x.role, 'allocation_id', x.allocation_id, 'finance_document_id', f.id, 'original_name', f.original_name,
        'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'storage_bucket', f.storage_bucket,
        'storage_path', CASE WHEN f.voided_at IS NULL THEN f.storage_path END,
        'removed_at', x.removed_at, 'remove_reason', x.remove_reason, 'created_at', x.created_at) ORDER BY x.created_at, x.id)
      FROM public.payment_documents x JOIN public.finance_documents f ON f.id = x.finance_document_id WHERE x.disbursement_id = d.id), '[]'::jsonb),
    'corrects', (SELECT jsonb_build_object('id', o.id, 'ref', o.ref) FROM public.client_disbursements o WHERE o.id = d.corrects_id),
    'corrected_by', (SELECT jsonb_build_object('id', o.id, 'ref', o.ref) FROM public.client_disbursements o WHERE o.id = d.corrected_by_id),
    'custody_deductions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'ref', e.ref, 'client_id', e.client_id, 'transaction_id', e.transaction_id,
        'amount', e.amount, 'status', e.status) ORDER BY e.created_at)
      FROM public.client_custody_entries e WHERE e.disbursement_id = d.id), '[]'::jsonb),
    'four_eyes', jsonb_build_object('creator', d.created_by, 'can_review', d.status = 'recorded' AND d.review_status = 'pending'
      AND app.has_branch_role(d.org_id, d.branch_id, app.fin_approve_roles()) AND NOT app.pay_is_author(d.id, auth.uid())))
$$;

-- an earlier recorded entry of the org that uses the same reference (field: sadad_number | bank_reference | receipt_no),
-- or NULL: {id, ref, transaction_ref, amount, field} (legacy assertNoDuplicatePayment_ cites the transaction and the amount).
-- Uniqueness is org-wide, but an entry of a branch the caller cannot read is only reported as taken: {field, hidden: true}.
CREATE OR REPLACE FUNCTION app.pay_ref_conflict(p_org uuid, p_field text, p_norm text, p_exclude uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles()) THEN
           jsonb_build_object('field', p_field, 'id', d.id, 'ref', d.ref, 'amount', d.paid_amount, 'paid_at', d.paid_at, 'hidden', false,
             'transaction_ref', (SELECT t.ref FROM public.disbursement_allocations a JOIN public.transactions t ON t.id = a.transaction_id
                                  WHERE a.disbursement_id = d.id ORDER BY a.seq LIMIT 1))
         ELSE jsonb_build_object('field', p_field, 'id', NULL, 'ref', NULL, 'amount', NULL, 'paid_at', NULL, 'transaction_ref', NULL, 'hidden', true) END
    FROM public.client_disbursements d
   WHERE p_norm IS NOT NULL AND d.org_id = p_org AND d.status = 'recorded' AND d.id IS DISTINCT FROM p_exclude
     AND CASE p_field WHEN 'sadad_number' THEN d.sadad_number = p_norm WHEN 'bank_reference' THEN d.bank_ref_norm = p_norm
                      ELSE d.receipt_norm = p_norm END
   ORDER BY d.created_at LIMIT 1
$$;

-- why an entry can no longer be voided / corrected: 'daftra' (linked in Daftra), 'invoiced' (a charge it created is
-- invoiced or in a billing intent), 'custody' (an active custody deduction uses it), or NULL
CREATE OR REPLACE FUNCTION app.pay_locked(d public.client_disbursements) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN d.daftra_draft_id IS NOT NULL OR d.daftra_linked_at IS NOT NULL THEN 'daftra'
    WHEN EXISTS (SELECT 1 FROM public.disbursement_allocations a JOIN public.client_charges c ON c.id = a.client_charge_id
                  WHERE a.disbursement_id = d.id AND (c.status = 'invoiced'
                    OR EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = c.id AND l.state <> 'removed'))) THEN 'invoiced'
    WHEN EXISTS (SELECT 1 FROM public.client_custody_entries e WHERE e.disbursement_id = d.id AND e.status = 'active') THEN 'custody'
  END
$$;

-- the reference keys are always derived from the stored values (never from the caller)
CREATE OR REPLACE FUNCTION app.tg_pay_before() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.bank_ref_norm := app.pay_ref_norm('bank', NEW.bank_reference);
  NEW.receipt_norm := app.pay_ref_norm('receipt', NEW.receipt_no);
  RETURN NEW;
END $$;

-- append-only: only the review fields, the void fields (recorded → void, once) and the correction link change
CREATE OR REPLACE FUNCTION app.tg_pay_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
-- (difference is a generated column: NULL in a BEFORE trigger, recomputed from the guarded amounts)
DECLARE v_free text[] := ARRAY['review_status','reviewed_by','reviewed_at','review_note','status','void_reason','voided_by',
                               'voided_at','corrected_by_id','updated_at','difference'];
BEGIN
  PERFORM app.guard_immutable(to_jsonb(OLD) - v_free, to_jsonb(NEW) - v_free,
                              ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - v_free)));
  -- a void entry is final: only its correction link may still be set (once)
  IF OLD.status = 'void' AND (to_jsonb(NEW) - ARRAY['corrected_by_id','updated_at','difference']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['corrected_by_id','updated_at','difference']) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'void');
  END IF;
  IF NEW.status = 'recorded' AND OLD.status = 'void' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'void'); END IF;
  IF NEW.corrected_by_id IS DISTINCT FROM OLD.corrected_by_id AND OLD.corrected_by_id IS NOT NULL THEN
    PERFORM app.fail('MRS_IMMUTABLE', 'corrected_by_id');
  END IF;
  RETURN NEW;
END $$;

-- allocations: only the links booked by the save (NULL → value, once) and the void stamp change
CREATE OR REPLACE FUNCTION app.tg_pay_alloc_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_free text[] := ARRAY['supplier_invoice_id','supplier_payment_id','client_charge_id','voided_at'];
        c text;
BEGIN
  PERFORM app.guard_immutable(to_jsonb(OLD) - v_free, to_jsonb(NEW) - v_free, ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - v_free)));
  FOREACH c IN ARRAY v_free LOOP
    IF (to_jsonb(OLD) -> c) <> 'null'::jsonb AND (to_jsonb(OLD) -> c) IS DISTINCT FROM (to_jsonb(NEW) -> c) THEN
      PERFORM app.fail('MRS_IMMUTABLE', c);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- documents: only the soft removal (once)
CREATE OR REPLACE FUNCTION app.tg_pay_doc_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_free text[] := ARRAY['removed_at','removed_by','remove_reason'];
BEGIN
  IF OLD.removed_at IS NOT NULL THEN PERFORM app.fail('MRS_IMMUTABLE', 'removed_at'); END IF;
  PERFORM app.guard_immutable(to_jsonb(OLD) - v_free, to_jsonb(NEW) - v_free, ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - v_free)));
  RETURN NEW;
END $$;

-- deferred (end of the transaction): a recorded entry has its allocations — single exactly 1, shared ≥ 2 — and
-- Σ allocations = paid amount (legacy: |Σ − total| < 0.005, i.e. equal in halalas)
CREATE OR REPLACE FUNCTION app.tg_pay_sum() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'client_disbursements' THEN 'id' ELSE 'disbursement_id' END)::uuid;
        d public.client_disbursements; v_n int; v_sum numeric;
BEGIN
  SELECT * INTO d FROM public.client_disbursements x WHERE x.id = v_id;
  IF d.id IS NULL OR d.status <> 'recorded' THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(a.amount), 0) INTO v_n, v_sum FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id;
  IF (d.pattern = 'single' AND v_n <> 1) OR (d.pattern = 'shared' AND v_n < 2) THEN PERFORM app.fail('MRS_PAY_ALLOCATION', 'count'); END IF;
  IF abs(v_sum - d.paid_amount) >= 0.005 THEN PERFORM app.fin_fail('MRS_PAY_ALLOCATION', 'sum', v_sum::text); END IF;
  RETURN NULL;
END $$;

-- custody: only active → void (once); signed_amount is generated (NULL in a BEFORE trigger)
CREATE OR REPLACE FUNCTION app.tg_custody_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_free text[] := ARRAY['status','void_reason','voided_by','voided_at','signed_amount'];
BEGIN
  IF OLD.status = 'void' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'void'); END IF;
  PERFORM app.guard_immutable(to_jsonb(OLD) - v_free, to_jsonb(NEW) - v_free, ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - v_free)));
  RETURN NEW;
END $$;

-- the client balance (Σ signed amounts of the active entries)
CREATE OR REPLACE FUNCTION app.custody_balance(p_client uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(sum(e.signed_amount), 0)::numeric(14,2) FROM public.client_custody_entries e WHERE e.client_id = p_client AND e.status = 'active'
$$;

-- the hard guarantee behind the RPC checks: after any insert / void the client balance is ≥ 0
CREATE OR REPLACE FUNCTION app.tg_custody_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v numeric := app.custody_balance(NEW.client_id);
BEGIN
  IF v < 0 THEN PERFORM app.fin_fail('MRS_CUSTODY_NEGATIVE', NEW.kind, v::text); END IF;
  RETURN NULL;
END $$;

-- one writer per client at a time (legacy LockService document lock, per client here)
CREATE OR REPLACE FUNCTION app.custody_lock(p_client uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('marsa.custody:' || p_client::text, 0))
$$;

CREATE OR REPLACE FUNCTION app.custody_json(e public.client_custody_entries) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(e) || jsonb_build_object(
    'client_name', (SELECT c.name_ar FROM public.clients c WHERE c.id = e.client_id),
    'transaction_ref', (SELECT t.ref FROM public.transactions t WHERE t.id = e.transaction_id),
    'payment_ref', (SELECT d.ref FROM public.client_disbursements d WHERE d.id = e.disbursement_id))
$$;

-- G4 (20261104000100 §7, re-created): body identical except (LEGACY PAY) a client-direct payment booked from the register
-- (disbursement_allocation_id set: the allocation's transaction is that client's) settles the client's share without a
-- G4 cost allocation on the invoice. The overpay cap and the «charged to the client» guard still apply to every payment.
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
  IF NEW.payer = 'client' AND NEW.disbursement_allocation_id IS NULL THEN                                    -- LEGACY PAY
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

-- void an entry and everything it booked: the G4 supplier payments, the draft / approved charges it created, the
-- supplier invoices it created when nothing else hangs on them, the allocation stamps, the documents (soft removal).
-- p_mode 'void' | 'correction'. The caller checked app.pay_locked and the role.
CREATE OR REPLACE FUNCTION app.pay_void_core(p_d public.client_disbursements, p_reason text, p_mode text) RETURNS public.client_disbursements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.client_disbursements; r record; si public.supplier_invoices;
BEGIN
  UPDATE public.client_disbursements x SET status = 'void', void_reason = p_reason, voided_by = auth.uid(), voided_at = now(), updated_at = now()
   WHERE x.id = p_d.id RETURNING * INTO d;
  UPDATE public.supplier_payments sp SET status = 'void', void_reason = 'payment ' || d.ref || ' ' || p_mode || ': ' || p_reason,
         voided_by = auth.uid(), voided_at = now()
   WHERE sp.status = 'recorded' AND sp.disbursement_allocation_id IN (SELECT a.id FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id);
  UPDATE public.client_charges c SET status = 'void', void_reason = 'payment ' || d.ref || ' ' || p_mode || ': ' || p_reason, updated_at = now()
   WHERE c.status IN ('draft','approved') AND c.id IN (SELECT a.client_charge_id FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id);
  FOR r IN SELECT DISTINCT a.supplier_invoice_id id FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id AND a.supplier_invoice_id IS NOT NULL LOOP
    SELECT * INTO si FROM public.supplier_invoices x WHERE x.id = r.id FOR UPDATE;
    IF si.created_by_disbursement_id = d.id AND si.status <> 'void'
       AND NOT EXISTS (SELECT 1 FROM public.supplier_payments sp WHERE sp.supplier_invoice_id = si.id AND sp.status = 'recorded')
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = si.id)
       AND NOT EXISTS (SELECT 1 FROM public.cost_allocations ca WHERE ca.supplier_invoice_id = si.id AND ca.status IN ('proposed','approved'))
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoices cn WHERE cn.adjusts_invoice_id = si.id AND cn.status <> 'void') THEN
      PERFORM app.fin_void_invoice(si, 'payment ' || d.ref || ' ' || p_mode || ': ' || p_reason, NULL);
    END IF;
  END LOOP;
  UPDATE public.disbursement_allocations a SET voided_at = now() WHERE a.disbursement_id = d.id AND a.voided_at IS NULL;
  UPDATE public.payment_documents x SET removed_at = now(), removed_by = auth.uid(),
         remove_reason = CASE WHEN p_mode = 'correction' THEN 'corrected' ELSE 'payment_void' END
   WHERE x.disbursement_id = d.id AND x.removed_at IS NULL;
  FOR r IN SELECT DISTINCT a.transaction_id FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id LOOP
    PERFORM app.fin_event(d.org_id, r.transaction_id, CASE WHEN p_mode = 'correction' THEN 'payment_corrected_out' ELSE 'payment_voided' END,
                          'client_disbursement', d.id, 'recorded', 'void', jsonb_build_object('ref', d.ref));
  END LOOP;
  RETURN d;
END $$;

-- the core save (record_payment_bundle / correct_payment). p_old = the entry being corrected (already voided by
-- app.pay_void_core in mode 'correction': its references are free and its live documents were marked 'corrected'),
-- or NULL. → the new entry id. Every refusal raises before anything is written.
CREATE OR REPLACE FUNCTION app.pay_record(p jsonb, p_old public.client_disbursements) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_mt text; v_pat text; v_item public.org_service_items; v_item_id uuid; v_code text; v_tx public.transactions;
  v_in jsonb; v_rows jsonb := '[]'::jsonb; x jsonb; y jsonb; i int; j int; n int; v_org uuid; v_branch uuid; v_clients uuid[] := '{}';
  v_paid numeric; v_exp numeric; v_at date; v_src text; v_method text; v_acct text; v_payer text; v_benef uuid; v_bp public.parties;
  v_bname text; v_channel text; v_sadad text; v_bank text; v_receipt text; v_rule text; v_review text; v_appt text; v_notes text;
  v_confirm boolean; v_charge boolean; v_sum numeric := 0; v_claim text; v_norm text; v_internal text; v_conf jsonb; v_other text;
  v_docs jsonb := '[]'::jsonb; v_new_bytes bigint := 0; v_new_n int := 0; v_f public.finance_documents; v_role text; v_aidx int;
  v_d public.client_disbursements; v_alloc public.disbursement_allocations; v_si public.supplier_invoices; v_siid uuid;
  v_sp public.supplier_payments; v_proof uuid; v_inv_doc uuid; v_ref_any text; v_charge_res jsonb; v_keep boolean; v_rm uuid[] := '{}';
  v_txids uuid[] := '{}'; r record; v_dt date; v_vat numeric; v_tot numeric; v_seq bigint; v_reuse text[] := '{}';
  v_old_si public.supplier_invoices;
BEGIN
  PERFORM app.only_keys(p, ARRAY['movement_type','pattern','service_item_id','service_code','transaction_id','claim_no','internal_invoice_no',
    'invoice_date','invoice_vat_amount','invoice_total','supplier_invoice_id','appointment_no','expected_amount','paid_amount','paid_at',
    'funding_source','method','paying_account','payer_name','beneficiary_party_id','payment_channel','sadad_number','bank_reference',
    'receipt_no','notes','review_status','confirm_invoice_reuse','charge_client','allocations','documents','keep_documents',
    'remove_document_ids','idempotencyKey']);
  v_mt := app.ptext(p, 'movement_type', 30, true);
  IF NOT app.is_code('pay_movement_type', v_mt) THEN PERFORM app.fail('MRS_INVALID', 'movement_type'); END IF;
  v_pat := coalesce(app.ptext(p, 'pattern', 10), 'single');
  IF v_pat NOT IN ('single','shared') THEN PERFORM app.fail('MRS_INVALID', 'pattern'); END IF;

  IF NOT (p ? 'paid_amount') OR jsonb_typeof(p -> 'paid_amount') = 'null' THEN PERFORM app.fail('MRS_REQUIRED', 'paid_amount'); END IF;
  IF coalesce(app.fin_money(p, 'paid_amount'), 0) <= 0 THEN PERFORM app.fail('MRS_INVALID', 'paid_amount'); END IF;

  /* ---- the lines (single: one line from the top-level fields; shared: allocations[] ≥ 2) */
  IF v_pat = 'single' THEN
    IF p ? 'allocations' AND jsonb_typeof(p -> 'allocations') <> 'null' THEN PERFORM app.fail('MRS_PAY_ALLOCATION', 'not_allowed'); END IF;
    v_in := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('transaction_id', p -> 'transaction_id', 'amount', p -> 'paid_amount',
      'claim_no', p -> 'claim_no', 'internal_invoice_no', p -> 'internal_invoice_no', 'invoice_date', p -> 'invoice_date',
      'invoice_vat_amount', p -> 'invoice_vat_amount', 'invoice_total', p -> 'invoice_total',
      'supplier_invoice_id', p -> 'supplier_invoice_id')));
    IF app.puuid(p, 'transaction_id') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  ELSE
    IF p ? 'transaction_id' OR p ? 'claim_no' OR p ? 'internal_invoice_no' OR p ? 'supplier_invoice_id' THEN
      PERFORM app.fail('MRS_PAY_ALLOCATION', 'not_allowed');
    END IF;
    v_in := p -> 'allocations';
    IF jsonb_typeof(v_in) IS DISTINCT FROM 'array' OR jsonb_array_length(v_in) < 2 THEN PERFORM app.fail('MRS_PAY_ALLOCATION', 'count'); END IF;
    IF jsonb_array_length(v_in) > 50 THEN PERFORM app.fail('MRS_PAY_ALLOCATION', 'count'); END IF;
  END IF;
  n := jsonb_array_length(v_in);
  FOR i IN 0 .. n - 1 LOOP
    x := v_in -> i;
    IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN PERFORM app.fail('MRS_INVALID', 'allocations'); END IF;
    PERFORM app.only_keys(x, ARRAY['transaction_id','amount','claim_no','internal_invoice_no','invoice_date','invoice_vat_amount',
                                   'invoice_total','supplier_invoice_id','notes','key']);
    IF app.puuid(x, 'transaction_id') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
    v_tx := app.g3_lock_tx(app.puuid(x, 'transaction_id'), app.fin_write_roles());
    IF v_org IS NULL THEN v_org := v_tx.org_id; v_branch := v_tx.branch_id; END IF;
    IF v_tx.org_id <> v_org OR v_tx.branch_id <> v_branch THEN PERFORM app.fail('MRS_PAY_ALLOCATION', 'branch'); END IF;
    IF NOT (v_tx.client_id = ANY (v_clients)) THEN v_clients := v_clients || v_tx.client_id; END IF;
    v_txids := v_txids || v_tx.id;
    v_paid := app.fin_money(x, 'amount');
    IF v_paid IS NULL OR v_paid <= 0 THEN PERFORM app.fail('MRS_PAY_ALLOCATION', 'amount'); END IF;
    v_claim := app.ptext(x, 'claim_no', 60);
    v_norm := CASE WHEN v_claim IS NULL THEN NULL ELSE app.pay_inv_key(v_claim) END;
    IF v_claim IS NOT NULL AND v_norm IS NULL THEN PERFORM app.fail('MRS_INVALID', 'claim_no'); END IF;
    v_internal := app.ptext(x, 'internal_invoice_no', 60);
    IF v_internal IS NOT NULL AND (upper(app.to_western(v_internal)) !~ '^[A-Z0-9][A-Z0-9 /._-]*$') THEN PERFORM app.fail('MRS_INVALID', 'internal_invoice_no'); END IF;
    v_internal := upper(app.to_western(v_internal));
    v_vat := app.fin_money(x, 'invoice_vat_amount');
    v_tot := app.fin_money(x, 'invoice_total');
    IF v_tot IS NOT NULL AND v_tot <= 0 THEN PERFORM app.fail('MRS_INVALID', 'invoice_total'); END IF;
    IF x ? 'invoice_date' AND x ->> 'invoice_date' IS NOT NULL AND app.pdate(x, 'invoice_date') IS NULL THEN PERFORM app.fail('MRS_INVALID', 'invoice_date'); END IF;
    v_rows := v_rows || jsonb_build_object('tx', v_tx.id, 'client', v_tx.client_id, 'tx_ref', v_tx.ref, 'amount', v_paid,
      'claim', v_claim, 'norm', v_norm, 'internal', v_internal, 'inv_date', app.pdate(x, 'invoice_date'),
      'vat', v_vat, 'total', v_tot, 'si', app.puuid(x, 'supplier_invoice_id'), 'notes', app.ptext(x, 'notes', 500),
      'key', app.ptext(x, 'key', 60));
    v_sum := v_sum + v_paid;
  END LOOP;
  -- no duplicate transaction + invoice inside the entry
  FOR i IN 0 .. n - 1 LOOP
    FOR j IN i + 1 .. n - 1 LOOP
      IF (v_rows -> i ->> 'tx') = (v_rows -> j ->> 'tx') AND (v_rows -> i ->> 'norm') IS NOT DISTINCT FROM (v_rows -> j ->> 'norm') THEN
        PERFORM app.fail('MRS_PAY_ALLOCATION', 'duplicate');
      END IF;
    END LOOP;
  END LOOP;

  /* ---- service item, amounts, date */
  v_item_id := app.puuid(p, 'service_item_id');
  v_code := app.ptext(p, 'service_code', 40);
  SELECT * INTO v_item FROM public.org_service_items s
   WHERE s.org_id = v_org AND s.is_active AND ((v_item_id IS NOT NULL AND s.id = v_item_id) OR (v_item_id IS NULL AND s.code = v_code));
  IF v_item.id IS NULL THEN
    PERFORM app.fail(CASE WHEN v_item_id IS NULL AND v_code IS NULL THEN 'MRS_REQUIRED' ELSE 'MRS_INVALID' END, 'service_item');
  END IF;
  -- an appointment fee (Fasah gate-in / gate-out): the claim no is the Reference No, never the internal FP… number
  -- (legacy R12Client r121NormalizeAppointmentPaymentPayload, rule r12.1.5)
  IF v_item.code IN ('gate_in_appointment','gate_out_appointment') OR v_item.fin_service IN ('gate_in_appointment','gate_out_appointment') THEN
    FOR i IN 0 .. n - 1 LOOP
      IF upper(app.to_western(coalesce(v_rows -> i ->> 'claim', ''))) ~ '^[[:space:]]*FP' THEN PERFORM app.fail('MRS_INVALID', 'claim_no_fp'); END IF;
    END LOOP;
  END IF;
  v_paid := app.fin_money(p, 'paid_amount');
  IF v_paid IS NULL OR v_paid <= 0 THEN PERFORM app.fail('MRS_INVALID', 'paid_amount'); END IF;
  IF abs(v_sum - v_paid) >= 0.005 THEN PERFORM app.fin_fail('MRS_PAY_ALLOCATION', 'sum', (v_paid - v_sum)::text); END IF;
  v_exp := coalesce(app.fin_money(p, 'expected_amount'), v_paid);
  v_at := app.pdate(p, 'paid_at');
  IF v_at IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'paid_at'); END IF;
  IF v_at > (now() AT TIME ZONE 'Asia/Riyadh')::date OR v_at < DATE '2000-01-01' THEN PERFORM app.fail('MRS_INVALID', 'paid_at'); END IF;

  /* ---- funding source × method, payer, beneficiary (legacy normalizePaymentFundingSource_ / savePaymentRecord) */
  v_method := app.ptext(p, 'method', 20, true);
  IF v_method NOT IN ('sadad','mada','fasah_wallet','dry_port_wallet','bank_transfer','cash','cheque','other') THEN
    PERFORM app.fail('MRS_INVALID', 'method');
  END IF;
  v_src := app.ptext(p, 'funding_source', 40);
  IF v_mt = 'client_direct' THEN v_src := 'client_direct';
  ELSIF v_mt = 'received_from_client' THEN v_src := 'not_applicable_receipt';
  ELSIF v_src IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'funding_source');
  ELSIF v_src NOT IN ('org_account','cash_box','fasah_wallet','dry_port_wallet_org','client_custody','client_custody_dry_port','personal_account') THEN
    PERFORM app.fail('MRS_PAY_FUNDING', 'funding_source');
  END IF;
  IF (v_mt <> 'org_paid' OR v_src IN ('client_custody','client_custody_dry_port')) AND cardinality(v_clients) > 1 THEN
    PERFORM app.fail('MRS_PAY_ALLOCATION', 'client');
  END IF;
  v_acct := app.ptext(p, 'paying_account', 120);
  v_payer := app.ptext(p, 'payer_name', 160);
  IF v_mt = 'org_paid' THEN
    IF v_src = 'org_account' THEN v_payer := app.pay_org_payer(v_org);
    ELSIF v_src = 'fasah_wallet' THEN v_payer := 'محفظة فسح';
    ELSIF v_src IN ('dry_port_wallet_org','client_custody_dry_port') THEN v_payer := 'محفظة الميناء الجاف';
    ELSIF v_src = 'cash_box' THEN v_payer := coalesce(v_payer, app.pay_org_payer(v_org));
    ELSIF v_src = 'client_custody' THEN v_payer := coalesce(v_payer, (SELECT c.name_ar FROM public.clients c WHERE c.id = v_clients[1]));
    END IF;
  ELSE
    v_payer := coalesce(v_payer, (SELECT left(c.name_ar, 160) FROM public.clients c WHERE c.id = v_clients[1]));
  END IF;
  v_rule := app.fin_funding_check(v_src, v_method, v_payer, v_acct, false);
  IF v_rule IS NOT NULL THEN PERFORM app.fail('MRS_PAY_FUNDING', v_rule); END IF;
  IF v_payer IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'payer_name'); END IF;
  v_benef := app.puuid(p, 'beneficiary_party_id');
  IF v_mt = 'received_from_client' THEN
    IF v_benef IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'beneficiary_party_id'); END IF;
    v_bname := app.pay_org_payer(v_org);
  ELSE
    IF v_benef IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'beneficiary_party_id'); END IF;
    SELECT * INTO v_bp FROM public.parties pa WHERE pa.id = v_benef AND pa.org_id = v_org AND pa.is_active;
    IF v_bp.id IS NULL THEN PERFORM app.fail('MRS_INVALID', 'beneficiary_party_id'); END IF;
    v_bname := left(v_bp.name_ar, 160);
  END IF;
  v_channel := app.ptext(p, 'payment_channel', 60);

  /* ---- method references (legacy normalizePaymentNumberInput_ / normalizeBankReferenceInput_ / normalizeGeneralReferenceInput_) */
  v_sadad := app.to_western(app.ptext(p, 'sadad_number', 30));
  v_bank := upper(app.to_western(app.ptext(p, 'bank_reference', 60)));
  v_receipt := app.to_western(app.ptext(p, 'receipt_no', 100));
  IF v_sadad IS NOT NULL AND v_sadad !~ '^[0-9]+$' THEN PERFORM app.fail('MRS_PAY_REFERENCE', 'sadad_number'); END IF;
  IF v_bank IS NOT NULL AND v_bank !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' THEN PERFORM app.fail('MRS_PAY_REFERENCE', 'bank_reference'); END IF;
  IF v_receipt IS NOT NULL AND v_receipt !~ ('^[A-Za-z0-9' || chr(1536) || '-' || chr(1791) || '][A-Za-z0-9' || chr(1536) || '-' || chr(1791) || '[:space:]/._-]*$') THEN
    PERFORM app.fail('MRS_PAY_REFERENCE', 'receipt_no');
  END IF;
  IF v_method = 'sadad' THEN
    IF v_sadad IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'sadad_number'); END IF;
    IF v_bank IS NOT NULL THEN PERFORM app.fail('MRS_PAY_REF_METHOD', 'bank_reference'); END IF;
    IF v_receipt IS NOT NULL THEN PERFORM app.fail('MRS_PAY_REF_METHOD', 'receipt_no'); END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF v_bank IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bank_reference'); END IF;
    IF v_sadad IS NOT NULL THEN PERFORM app.fail('MRS_PAY_REF_METHOD', 'sadad_number'); END IF;
    IF v_receipt IS NOT NULL THEN PERFORM app.fail('MRS_PAY_REF_METHOD', 'receipt_no'); END IF;
  ELSIF v_method IN ('mada','cash','cheque','other') THEN
    IF v_receipt IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'receipt_no'); END IF;
    IF v_sadad IS NOT NULL THEN PERFORM app.fail('MRS_PAY_REF_METHOD', 'sadad_number'); END IF;
    IF v_bank IS NOT NULL THEN PERFORM app.fail('MRS_PAY_REF_METHOD', 'bank_reference'); END IF;
  END IF;
  v_ref_any := coalesce(v_sadad, v_bank, v_receipt);

  /* ---- appointment no (TAS), review state, flags */
  IF app.ptext(p, 'appointment_no', 80) IS NOT NULL THEN
    v_appt := app.norm_tas(app.ptext(p, 'appointment_no', 80));
    IF v_appt IS NULL THEN PERFORM app.fail('MRS_INVALID', 'appointment_no'); END IF;
  END IF;
  v_review := coalesce(app.ptext(p, 'review_status', 20), 'pending');
  IF v_review NOT IN ('draft','pending') THEN PERFORM app.fail('MRS_INVALID', 'review_status'); END IF;
  v_confirm := app.pbool(p, 'confirm_invoice_reuse');
  v_charge := app.pbool(p, 'charge_client');
  IF v_charge AND v_mt <> 'org_paid' THEN PERFORM app.fail('MRS_INVALID', 'charge_client'); END IF;
  v_notes := app.ptext(p, 'notes', 2000);

  /* ---- global duplicates of the references (the message cites the earlier entry, its transaction and amount) */
  PERFORM pg_advisory_xact_lock(hashtextextended('marsa.pay:' || v_org::text, 0));
  FOR r IN SELECT * FROM (VALUES ('sadad_number', v_sadad), ('bank_reference', app.pay_ref_norm('bank', v_bank)),
                                 ('receipt_no', app.pay_ref_norm('receipt', v_receipt))) t(f, v) WHERE t.v IS NOT NULL LOOP
    v_conf := app.pay_ref_conflict(v_org, r.f, r.v, NULL);
    IF v_conf IS NOT NULL THEN
      -- an entry of a branch the caller cannot read: «taken», without its ref / transaction / amount
      PERFORM app.fin_fail('MRS_PAY_REF_TAKEN', r.f, CASE WHEN (v_conf ->> 'hidden')::boolean THEN NULL ELSE
                           (v_conf ->> 'ref') || ' · ' || coalesce(v_conf ->> 'transaction_ref', '-') || ' · '
                           || to_char((v_conf ->> 'amount')::numeric, 'FM999999999990.00') || ' ' || 'SAR' END);
    END IF;
  END LOOP;

  /* ---- invoice identity per line (org paid / client direct with a claim no; legacy assertInvoiceIdentity_) */
  FOR i IN 0 .. n - 1 LOOP
    x := v_rows -> i;
    v_norm := x ->> 'norm';
    v_siid := NULL;
    IF (x ->> 'si') IS NOT NULL THEN
      SELECT * INTO v_si FROM public.supplier_invoices si WHERE si.id = (x ->> 'si')::uuid AND si.org_id = v_org;
      IF v_si.id IS NULL OR v_mt = 'received_from_client' OR v_si.supplier_id IS DISTINCT FROM v_benef OR v_si.status = 'void'
         OR v_si.doc_type = 'credit_note' OR (v_norm IS NOT NULL AND app.pay_inv_key(v_si.invoice_number) IS DISTINCT FROM v_norm)
         OR NOT app.has_branch_role(v_si.org_id, v_si.branch_id, app.fin_read_roles()) THEN
        PERFORM app.fail('MRS_INVALID', 'supplier_invoice_id');
      END IF;
      v_norm := app.pay_inv_key(v_si.invoice_number);
      v_rows := jsonb_set(v_rows, ARRAY[i::text], x || jsonb_build_object('norm', v_norm, 'claim', coalesce(x ->> 'claim', v_si.invoice_number)));
      x := v_rows -> i;
    END IF;
    IF v_norm IS NULL OR v_mt = 'received_from_client' THEN
      IF (x ->> 'internal') IS NOT NULL AND v_mt = 'received_from_client' THEN PERFORM app.fail('MRS_INVALID', 'internal_invoice_no'); END IF;
      -- a line without an invoice no may still carry the internal (FP…) number: it is unique all the same
      IF (x ->> 'internal') IS NOT NULL AND (
           EXISTS (SELECT 1 FROM public.supplier_invoices si WHERE si.org_id = v_org AND si.status <> 'void' AND si.internal_invoice_no IS NOT NULL
                    AND app.pay_int_key(si.internal_invoice_no) = app.pay_int_key(x ->> 'internal'))
           OR EXISTS (SELECT 1 FROM public.disbursement_allocations a WHERE a.org_id = v_org AND a.voided_at IS NULL AND a.internal_invoice_no IS NOT NULL
                    AND app.pay_int_key(a.internal_invoice_no) = app.pay_int_key(x ->> 'internal'))
           OR EXISTS (SELECT 1 FROM generate_series(0, i - 1) g WHERE app.pay_int_key(v_rows -> g ->> 'internal') = app.pay_int_key(x ->> 'internal'))) THEN
        PERFORM app.fin_fail('MRS_PAY_INVOICE_TAKEN', 'internal_invoice_no', x ->> 'internal');
      END IF;
      CONTINUE;
    END IF;
    -- the same issuer + the same number twice in this entry, or in a live entry → hard block
    FOR j IN 0 .. i - 1 LOOP
      IF (v_rows -> j ->> 'norm') = v_norm THEN PERFORM app.fin_fail('MRS_PAY_INVOICE_TAKEN', 'invoice_number', x ->> 'claim'); END IF;
    END LOOP;
    SELECT d.ref, t.ref AS tx_ref, a.amount, app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles()) AS vis INTO r
      FROM public.disbursement_allocations a JOIN public.client_disbursements d ON d.id = a.disbursement_id
      JOIN public.transactions t ON t.id = a.transaction_id
     WHERE a.org_id = v_org AND a.voided_at IS NULL AND a.beneficiary_party_id = v_benef AND a.invoice_norm = v_norm LIMIT 1;
    IF FOUND THEN
      -- an entry of a branch the caller cannot read is only reported as taken (no ref / transaction / amount)
      PERFORM app.fin_fail('MRS_PAY_INVOICE_TAKEN', 'invoice_number',
        CASE WHEN r.vis THEN r.ref || ' · ' || r.tx_ref || ' · ' || to_char(r.amount, 'FM999999999990.00') || ' SAR' END);
    END IF;
    -- an existing G4 invoice of the issuer with that number is reused (not created twice)
    IF (x ->> 'si') IS NULL THEN
      SELECT si.id INTO v_siid FROM public.supplier_invoices si
       WHERE si.org_id = v_org AND si.supplier_id = v_benef AND si.doc_type = 'invoice' AND app.pay_inv_key(si.invoice_number) = v_norm
         AND si.status <> 'void'
       ORDER BY si.created_at LIMIT 1;
      IF v_siid IS NOT NULL THEN
        SELECT * INTO v_si FROM public.supplier_invoices si WHERE si.id = v_siid;
        IF NOT app.has_branch_role(v_si.org_id, v_si.branch_id, app.fin_read_roles()) THEN PERFORM app.fin_fail('MRS_PAY_INVOICE_TAKEN', 'invoice_number', x ->> 'claim'); END IF;
        v_rows := jsonb_set(v_rows, ARRAY[i::text], x || jsonb_build_object('si', v_siid));
        x := v_rows -> i;
      END IF;
    END IF;
    -- the internal (FP…) number: unique among the org's non-void invoices AND the live register lines (legacy
    -- findInvoiceIdentityConflicts_ compares the stored payment / allocation internal ids); a reused G4 invoice that
    -- already carries another internal number is refused (the two would silently disagree)
    IF (x ->> 'internal') IS NOT NULL THEN
      IF (x ->> 'si') IS NOT NULL THEN
        SELECT si.internal_invoice_no INTO v_other FROM public.supplier_invoices si WHERE si.id = (x ->> 'si')::uuid;
        IF v_other IS NOT NULL AND app.pay_int_key(v_other) IS DISTINCT FROM app.pay_int_key(x ->> 'internal') THEN
          PERFORM app.fin_fail('MRS_INVALID', 'internal_invoice_mismatch', v_other);
        END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM public.supplier_invoices si
           WHERE si.org_id = v_org AND si.status <> 'void' AND si.internal_invoice_no IS NOT NULL
             AND app.pay_int_key(si.internal_invoice_no) = app.pay_int_key(x ->> 'internal')
             AND si.id IS DISTINCT FROM (x ->> 'si')::uuid)
         OR EXISTS (SELECT 1 FROM public.disbursement_allocations a
           WHERE a.org_id = v_org AND a.voided_at IS NULL AND a.internal_invoice_no IS NOT NULL
             AND app.pay_int_key(a.internal_invoice_no) = app.pay_int_key(x ->> 'internal')) THEN
        PERFORM app.fin_fail('MRS_PAY_INVOICE_TAKEN', 'internal_invoice_no', x ->> 'internal');
      END IF;
    END IF;
    FOR j IN 0 .. i - 1 LOOP
      IF (v_rows -> j ->> 'internal') IS NOT NULL AND app.pay_int_key(v_rows -> j ->> 'internal') = app.pay_int_key(x ->> 'internal') THEN
        PERFORM app.fin_fail('MRS_PAY_INVOICE_TAKEN', 'internal_invoice_no', x ->> 'internal');
      END IF;
    END LOOP;
    -- the same number from ANOTHER issuer → explicit confirmation (MRS_CONFIRM_INVOICE_REUSE); every such line of the
    -- entry is collected first (legacy assertInvoiceIdentity_ lists them) so the one confirmation covers what was shown;
    -- the issuer of a branch the caller cannot read is not named
    IF NOT v_confirm THEN
      SELECT CASE WHEN z.vis THEN coalesce(pa.name_ar, '-') ELSE '-' END INTO v_other FROM (
          SELECT a.beneficiary_party_id pid, app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles()) vis
            FROM public.disbursement_allocations a JOIN public.client_disbursements d ON d.id = a.disbursement_id
           WHERE a.org_id = v_org AND a.voided_at IS NULL AND a.invoice_norm = v_norm AND a.beneficiary_party_id IS DISTINCT FROM v_benef
          UNION ALL
          SELECT si.supplier_id, app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()) FROM public.supplier_invoices si
           WHERE si.org_id = v_org AND si.status <> 'void' AND app.pay_inv_key(si.invoice_number) = v_norm AND si.supplier_id <> v_benef) z
        LEFT JOIN public.parties pa ON pa.id = z.pid ORDER BY z.vis DESC LIMIT 1;
      IF FOUND THEN v_reuse := v_reuse || ((x ->> 'claim') || ' · ' || v_other); END IF;
    END IF;
  END LOOP;
  IF cardinality(v_reuse) > 0 THEN
    PERFORM app.fin_fail('MRS_CONFIRM_INVOICE_REUSE', 'invoice_number',
      array_to_string(v_reuse[1:5], '؛ ') || CASE WHEN cardinality(v_reuse) > 5 THEN ' (+' || (cardinality(v_reuse) - 5) || ')' ELSE '' END);
  END IF;

  /* ---- documents: new ones (≤ 8 per save, PDF / image ≤ 4 MB each, ≤ 12 MB in all) + the ones carried by a correction */
  IF p ? 'documents' AND jsonb_typeof(p -> 'documents') NOT IN ('array','null') THEN PERFORM app.fail('MRS_INVALID', 'documents'); END IF;
  IF jsonb_typeof(p -> 'documents') = 'array' THEN
    IF jsonb_array_length(p -> 'documents') > 8 THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'count'); END IF;
    FOR i IN 0 .. jsonb_array_length(p -> 'documents') - 1 LOOP
      y := p -> 'documents' -> i;
      IF jsonb_typeof(y) IS DISTINCT FROM 'object' THEN PERFORM app.fail('MRS_INVALID', 'documents'); END IF;
      PERFORM app.only_keys(y, ARRAY['finance_document_id','role','allocation']);
      v_role := app.ptext(y, 'role', 20, true);
      IF NOT app.is_code('pay_document_role', v_role) THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'role'); END IF;
      SELECT * INTO v_f FROM public.finance_documents f WHERE f.id = app.puuid(y, 'finance_document_id');
      IF v_f.id IS NULL OR v_f.org_id <> v_org OR v_f.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'finance_document_id'); END IF;
      IF v_f.branch_id <> v_branch THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'branch'); END IF;
      IF coalesce(v_f.mime_type, '') NOT IN ('application/pdf','image/jpeg','image/png','image/webp','image/heic') THEN
        PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'type', v_f.original_name);
      END IF;
      IF v_f.size_bytes > 4194304 THEN PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'size', v_f.original_name); END IF;
      IF EXISTS (SELECT 1 FROM public.payment_documents x2 WHERE x2.finance_document_id = v_f.id AND x2.removed_at IS NULL)
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_docs) e WHERE e ->> 'doc' = v_f.id::text) THEN
        PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'in_use', v_f.original_name);
      END IF;
      v_new_bytes := v_new_bytes + v_f.size_bytes;
      IF v_new_bytes > 12582912 THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'total'); END IF;
      v_aidx := NULL;
      IF y ? 'allocation' AND jsonb_typeof(y -> 'allocation') <> 'null' THEN
        IF v_pat = 'single' THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
        IF jsonb_typeof(y -> 'allocation') = 'number' THEN v_aidx := (y ->> 'allocation')::int;
        ELSE SELECT o.ord::int INTO v_aidx FROM jsonb_array_elements(v_rows) WITH ORDINALITY o(e, ord) WHERE o.e ->> 'key' = (y ->> 'allocation') LIMIT 1;
        END IF;
        IF v_aidx IS NULL OR v_aidx < 1 OR v_aidx > n THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
      END IF;
      IF v_pat = 'shared' AND v_role = 'entity_invoice' AND v_aidx IS NULL THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
      v_docs := v_docs || jsonb_build_object('doc', v_f.id, 'role', v_role, 'alloc', v_aidx);
    END LOOP;
  END IF;
  -- a correction keeps the documents of the corrected entry unless removed (the allocation link follows transaction + invoice)
  IF p_old.id IS NOT NULL THEN
    v_keep := coalesce(p ->> 'keep_documents', 'true') <> 'false';
    IF jsonb_typeof(p -> 'remove_document_ids') = 'array' THEN
      SELECT coalesce(array_agg(e::uuid), '{}') INTO v_rm FROM jsonb_array_elements_text(p -> 'remove_document_ids') e;
    END IF;
    FOR r IN SELECT x2.id, x2.finance_document_id, x2.role, a.transaction_id, a.invoice_norm, f.branch_id doc_branch, f.original_name
               FROM public.payment_documents x2 LEFT JOIN public.disbursement_allocations a ON a.id = x2.allocation_id
               JOIN public.finance_documents f ON f.id = x2.finance_document_id
              WHERE x2.disbursement_id = p_old.id AND x2.remove_reason = 'corrected' AND v_keep AND NOT (x2.id = ANY (v_rm))
              ORDER BY x2.created_at, x2.id LOOP
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_docs) e WHERE e ->> 'doc' = r.finance_document_id::text) THEN CONTINUE; END IF;
      -- the same branch rule as a new document: a correction moved to another branch does not take the old branch's files
      -- (the user un-ticks them — remove_document_ids — and attaches files of the new branch)
      IF r.doc_branch IS DISTINCT FROM v_branch THEN PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'branch', r.original_name); END IF;
      v_aidx := NULL;
      IF v_pat = 'shared' THEN
        SELECT o.ord::int INTO v_aidx FROM jsonb_array_elements(v_rows) WITH ORDINALITY o(e, ord)
         WHERE o.e ->> 'tx' = r.transaction_id::text AND (o.e ->> 'norm') IS NOT DISTINCT FROM r.invoice_norm LIMIT 1;
        IF v_aidx IS NULL AND r.role = 'entity_invoice' THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
      END IF;
      v_docs := v_docs || jsonb_build_object('doc', r.finance_document_id, 'role', r.role, 'alloc', v_aidx, 'carried', true);
    END LOOP;
  END IF;
  SELECT (e ->> 'doc')::uuid INTO v_proof FROM jsonb_array_elements(v_docs) e WHERE e ->> 'role' = 'payment_proof' LIMIT 1;
  -- a wallet payment needs a reference or the proof file; a G4 client-direct payment needs the proof file
  IF v_ref_any IS NULL AND v_proof IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'payment_reference'); END IF;
  IF v_mt = 'client_direct' AND v_proof IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE e ->> 'norm' IS NOT NULL) THEN
    PERFORM app.fail('MRS_REQUIRED', 'payment_proof');
  END IF;

  /* ---- write: the entry, its lines (+ the G4 invoice / payment / charge), its documents */
  v_seq := nextval('public.client_disbursements_seq');
  INSERT INTO public.client_disbursements (org_id, branch_id, seq, ref, movement_type, pattern, service_item_id, service_code, fin_service,
    claim_no, appointment_no, currency, expected_amount, paid_amount, paid_at, funding_source, method, paying_account, payer_name,
    beneficiary_party_id, beneficiary_name, payment_channel, sadad_number, bank_reference, receipt_no, review_status, corrects_id,
    original_created_by, charge_client, notes, created_by)
  VALUES (v_org, v_branch, v_seq, 'PAY-' || lpad(v_seq::text, 6, '0'), v_mt, v_pat, v_item.id, v_item.code,
    v_item.fin_service, CASE WHEN v_pat = 'single' THEN v_rows -> 0 ->> 'claim' END, v_appt, 'SAR', v_exp, v_paid, v_at, v_src, v_method,
    v_acct, v_payer, v_benef, v_bname, v_channel, v_sadad, v_bank, v_receipt, v_review, p_old.id,
    coalesce(p_old.original_created_by, p_old.created_by), v_charge, v_notes, auth.uid())
  RETURNING * INTO v_d;

  FOR i IN 0 .. n - 1 LOOP
    x := v_rows -> i;
    INSERT INTO public.disbursement_allocations (org_id, disbursement_id, seq, transaction_id, client_id, beneficiary_party_id, claim_no,
      invoice_norm, internal_invoice_no, amount, notes)
    VALUES (v_org, v_d.id, i + 1, (x ->> 'tx')::uuid, (x ->> 'client')::uuid, v_benef, x ->> 'claim', x ->> 'norm', x ->> 'internal',
      (x ->> 'amount')::numeric, x ->> 'notes')
    RETURNING * INTO v_alloc;
    IF v_mt <> 'received_from_client' AND (x ->> 'norm') IS NOT NULL THEN
      v_siid := (x ->> 'si')::uuid;
      IF v_siid IS NULL THEN
        SELECT (e ->> 'doc')::uuid INTO v_inv_doc FROM jsonb_array_elements(v_docs) e
         WHERE e ->> 'role' = 'entity_invoice' AND (v_pat = 'single' OR (e ->> 'alloc')::int = i + 1) LIMIT 1;
        -- the invoice total defaults to the line amount; a single entry uses the claim value when it is higher (a partial
        -- payment) and the paid amount when that is higher (legacy: difference = expected − paid may be negative)
        v_tot := coalesce((x ->> 'total')::numeric, CASE WHEN v_pat = 'single' THEN greatest(v_exp, (x ->> 'amount')::numeric) ELSE (x ->> 'amount')::numeric END);
        -- a correction keeps the invoice date / VAT of the invoice the corrected entry created for the same issuer + number
        -- when the form leaves them out (the void + re-record must never reset the purchase VAT to 0 or the date to paid_at)
        v_old_si := NULL;
        IF p_old.id IS NOT NULL AND ((x ->> 'vat') IS NULL OR (x ->> 'inv_date') IS NULL) THEN
          SELECT si.* INTO v_old_si FROM public.disbursement_allocations a JOIN public.supplier_invoices si ON si.id = a.supplier_invoice_id
           WHERE a.disbursement_id = p_old.id AND a.invoice_norm = (x ->> 'norm') AND si.supplier_id = v_benef
             AND si.created_by_disbursement_id = p_old.id
           ORDER BY a.seq LIMIT 1;
        END IF;
        v_vat := coalesce((x ->> 'vat')::numeric, CASE WHEN v_old_si.vat_amount <= v_tot THEN v_old_si.vat_amount END, 0);
        IF v_vat > v_tot THEN PERFORM app.fail('MRS_INVALID', 'invoice_vat_amount'); END IF;
        v_dt := coalesce((x ->> 'inv_date')::date, v_old_si.invoice_date, v_at);
        INSERT INTO public.supplier_invoices (org_id, branch_id, supplier_id, doc_type, invoice_number, number_norm, invoice_date, currency,
          subtotal, vat_amount, total_amount, supplier_vat_number, finance_document_id, internal_invoice_no, created_by_disbursement_id,
          notes, created_by)
        VALUES (v_org, v_branch, v_benef, 'invoice', x ->> 'claim', app.fin_norm_no(x ->> 'claim'), v_dt, 'SAR', v_tot - v_vat, v_vat, v_tot,
          v_bp.vat_number, v_inv_doc, x ->> 'internal', v_d.id, 'from payment ' || v_d.ref, auth.uid())
        RETURNING id INTO v_siid;
      ELSIF (x ->> 'internal') IS NOT NULL THEN
        UPDATE public.supplier_invoices si SET internal_invoice_no = x ->> 'internal'
         WHERE si.id = v_siid AND si.internal_invoice_no IS NULL;
      END IF;
      INSERT INTO public.supplier_payments (org_id, supplier_invoice_id, amount, currency, paid_at, method, payer, client_id, reference,
        evidence_document_id, disbursement_allocation_id, created_by)
      VALUES (v_org, v_siid, (x ->> 'amount')::numeric, 'SAR', v_at, v_method, CASE WHEN v_mt = 'client_direct' THEN 'client' ELSE 'company' END,
        CASE WHEN v_mt = 'client_direct' THEN (x ->> 'client')::uuid END, coalesce(v_ref_any, v_d.ref), v_proof, v_alloc.id, auth.uid())
      RETURNING * INTO v_sp;
      UPDATE public.disbursement_allocations a SET supplier_invoice_id = v_siid, supplier_payment_id = v_sp.id WHERE a.id = v_alloc.id;
    END IF;
    IF v_charge THEN
      v_charge_res := public.create_client_charge(jsonb_strip_nulls(jsonb_build_object('transaction_id', x ->> 'tx', 'kind', 'reimbursable',
        'description', left(v_item.name_ar || coalesce(' — ' || (x ->> 'claim'), ''), 300), 'unit_price', (x ->> 'amount')::numeric,
        'vat_rate', 0, 'service_code', v_item.fin_service, 'note', 'payment ' || v_d.ref)), NULL);
      UPDATE public.disbursement_allocations a SET client_charge_id = (v_charge_res ->> 'id')::uuid WHERE a.id = v_alloc.id;
    END IF;
  END LOOP;

  FOR i IN 0 .. jsonb_array_length(v_docs) - 1 LOOP
    y := v_docs -> i;
    INSERT INTO public.payment_documents (org_id, disbursement_id, allocation_id, finance_document_id, role, created_by)
    VALUES (v_org, v_d.id, (SELECT a.id FROM public.disbursement_allocations a WHERE a.disbursement_id = v_d.id AND a.seq = (y ->> 'alloc')::int),
            (y ->> 'doc')::uuid, y ->> 'role', auth.uid());
  END LOOP;

  FOR r IN SELECT DISTINCT a.transaction_id FROM public.disbursement_allocations a WHERE a.disbursement_id = v_d.id LOOP
    PERFORM app.fin_event(v_org, r.transaction_id, CASE WHEN p_old.id IS NULL THEN 'payment_recorded' ELSE 'payment_corrected_in' END,
                          'client_disbursement', v_d.id, NULL, v_review, jsonb_build_object('ref', v_d.ref, 'movement_type', v_mt, 'pattern', v_pat));
  END LOOP;
  RETURN v_d.id;
END $$;

-- ---------------------------------------------------------------------
-- 4. RPCs — the payment register
-- ---------------------------------------------------------------------
-- record_payment_bundle({movement_type, pattern?, service_item_id | service_code, transaction_id (single), claim_no?,
--   internal_invoice_no?, invoice_date?, invoice_vat_amount?, invoice_total?, supplier_invoice_id?, appointment_no?,
--   expected_amount?, paid_amount, paid_at, funding_source?, method, paying_account?, payer_name?, beneficiary_party_id?,
--   payment_channel?, sadad_number? | bank_reference? | receipt_no?, notes?, review_status? draft|pending,
--   confirm_invoice_reuse?, charge_client?, allocations?: [{transaction_id, amount, claim_no?, internal_invoice_no?,
--   invoice_date?, invoice_vat_amount?, invoice_total?, supplier_invoice_id?, notes?, key?}] (shared),
--   documents?: [{finance_document_id, role, allocation? (1-based index or key, shared only)}]}, p_idem_key)
-- → get_payment. Creates the supplier invoice when new, the booked G4 payment(s), the allocations, the attachments;
-- idempotent (same key + payload → the stored answer).
CREATE OR REPLACE FUNCTION public.record_payment_bundle(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_txid uuid; v_replay jsonb; v_id uuid; v_d public.client_disbursements; v_null public.client_disbursements;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_txid := coalesce(app.puuid(p_payload, 'transaction_id'),
                     CASE WHEN jsonb_typeof(p_payload -> 'allocations') = 'array' THEN app.puuid(p_payload -> 'allocations' -> 0, 'transaction_id') END);
  IF v_txid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction_id'); END IF;
  v_tx := app.g3_lock_tx(v_txid, app.fin_write_roles());
  v_replay := app.idem_begin('record_payment_bundle', p_idem_key, p_payload - 'idempotencyKey', v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF p_payload ? 'keep_documents' OR p_payload ? 'remove_document_ids' THEN PERFORM app.fail('MRS_INVALID', 'keep_documents'); END IF;
  v_id := app.pay_record(p_payload, v_null);
  SELECT * INTO v_d FROM public.client_disbursements d WHERE d.id = v_id;
  RETURN app.idem_finish('record_payment_bundle', p_idem_key, app.pay_detail(v_d));
END $$;

-- correct_payment(p_id, p_payload (the whole form, as record_payment_bundle + keep_documents? default true,
--   remove_document_ids? [payment_documents.id]), p_reason, p_idem_key) — legacy «تعديل»: void + re-record in ONE
-- transaction; the new entry points to the old one (corrects_id), starts pending review, keeps the documents.
-- An approved entry needs a finance approver; Daftra-linked / invoiced / custody-deducted entries are refused (MRS_PAY_LOCKED).
-- → {voided: the old entry, payment: the new entry, changed: [field names]}
CREATE OR REPLACE FUNCTION public.correct_payment(p_id uuid, p_payload jsonb, p_reason text, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old public.client_disbursements; v_replay jsonb; v_reason text; v_lock text; v_id uuid; v_new public.client_disbursements;
        v_changed text[]; r record; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  v_old := app.pay_lock(p_id, app.fin_write_roles());
  v_replay := app.idem_begin('correct_payment', p_idem_key, jsonb_build_object('id', p_id, 'payload', p_payload - 'idempotencyKey', 'reason', p_reason), v_old.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_old.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_old.status); END IF;
  IF v_old.review_status = 'approved' AND NOT app.has_branch_role(v_old.org_id, v_old.branch_id, app.fin_approve_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  v_reason := app.fin_note(p_reason, 'reason', 500);
  v_lock := app.pay_locked(v_old);
  IF v_lock IS NOT NULL THEN PERFORM app.fail('MRS_PAY_LOCKED', v_lock); END IF;
  v_old := app.pay_void_core(v_old, v_reason, 'correction');
  v_id := app.pay_record(p_payload, v_old);
  UPDATE public.client_disbursements d SET corrected_by_id = v_id, updated_at = now() WHERE d.id = v_old.id RETURNING * INTO v_old;
  SELECT * INTO v_new FROM public.client_disbursements d WHERE d.id = v_id;
  SELECT coalesce(array_agg(k ORDER BY k), '{}') INTO v_changed FROM jsonb_object_keys(to_jsonb(v_new)) k
   WHERE k IN ('movement_type','pattern','service_item_id','claim_no','appointment_no','expected_amount','paid_amount','paid_at','funding_source',
               'method','paying_account','payer_name','beneficiary_party_id','payment_channel','sadad_number','bank_reference','receipt_no','notes','charge_client')
     AND (to_jsonb(v_new) -> k) IS DISTINCT FROM (to_jsonb(v_old) -> k);
  IF (SELECT array_agg(a.transaction_id || ':' || a.amount || ':' || coalesce(a.invoice_norm, '') ORDER BY a.seq) FROM public.disbursement_allocations a WHERE a.disbursement_id = v_new.id)
     IS DISTINCT FROM (SELECT array_agg(a.transaction_id || ':' || a.amount || ':' || coalesce(a.invoice_norm, '') ORDER BY a.seq) FROM public.disbursement_allocations a WHERE a.disbursement_id = v_old.id) THEN
    v_changed := v_changed || 'allocations'::text;
  END IF;
  -- before / after (never amounts)
  FOR r IN SELECT DISTINCT a.transaction_id FROM public.disbursement_allocations a WHERE a.disbursement_id IN (v_old.id, v_new.id) LOOP
    PERFORM app.fin_event(v_new.org_id, r.transaction_id, 'payment_corrected', 'client_disbursement', v_new.id, v_old.ref, v_new.ref,
                          jsonb_build_object('before', v_old.id, 'after', v_new.id, 'changed', to_jsonb(v_changed)));
  END LOOP;
  v_res := jsonb_build_object('voided', app.pay_detail(v_old), 'payment', app.pay_detail(v_new), 'changed', to_jsonb(v_changed));
  RETURN app.idem_finish('correct_payment', p_idem_key, v_res);
END $$;

-- void_payment(p_id, p_reason) — finance approver; refused when Daftra-linked, invoiced or custody-deducted (MRS_PAY_LOCKED)
CREATE OR REPLACE FUNCTION public.void_payment(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_d public.client_disbursements; v_reason text; v_lock text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_d := app.pay_lock(p_id, app.fin_approve_roles());
  v_reason := app.fin_note(p_reason, 'reason', 500);
  IF v_d.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  v_lock := app.pay_locked(v_d);
  IF v_lock IS NOT NULL THEN PERFORM app.fail('MRS_PAY_LOCKED', v_lock); END IF;
  v_d := app.pay_void_core(v_d, v_reason, 'void');
  RETURN app.pay_detail(v_d);
END $$;

-- review_payment(p_id, submit | approve | reject, p_note) — submit: draft → pending (a finance writer of the branch);
-- approve / reject: pending → approved / rejected by a finance approver who is NOT the creator — nor the creator of any entry
-- it corrects (four eyes, admins included);
-- a rejection needs a note. Nothing else changes (the AI never approves).
CREATE OR REPLACE FUNCTION public.review_payment(p_id uuid, p_decision text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_d public.client_disbursements; v_from text; v_to text; v_note text; r record;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_decision NOT IN ('submit','approve','reject') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_d := app.pay_lock(p_id, CASE WHEN p_decision = 'submit' THEN app.fin_write_roles() ELSE app.fin_approve_roles() END);
  IF v_d.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  v_from := v_d.review_status;
  IF p_decision = 'submit' THEN
    IF v_from <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_from); END IF;
    v_to := 'pending';
    v_note := app.ptext(jsonb_build_object('n', p_note), 'n', 2000);
    UPDATE public.client_disbursements d SET review_status = 'pending', review_note = coalesce(v_note, d.review_note), updated_at = now()
     WHERE d.id = v_d.id RETURNING * INTO v_d;
  ELSE
    IF v_from <> 'pending' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_from); END IF;
    -- four eyes across corrections: whoever typed this entry or any entry it corrects (created_by / original_created_by
    -- along the corrects_id chain) never approves / rejects it
    IF app.pay_is_author(v_d.id, auth.uid()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'self_approval'); END IF;
    IF p_decision = 'reject' THEN v_note := app.fin_note(p_note, 'note', 2000);
    ELSE v_note := app.ptext(jsonb_build_object('n', p_note), 'n', 2000); END IF;
    v_to := CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END;
    UPDATE public.client_disbursements d SET review_status = v_to, reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note, updated_at = now()
     WHERE d.id = v_d.id RETURNING * INTO v_d;
  END IF;
  FOR r IN SELECT DISTINCT a.transaction_id FROM public.disbursement_allocations a WHERE a.disbursement_id = v_d.id LOOP
    PERFORM app.fin_event(v_d.org_id, r.transaction_id, 'payment_reviewed', 'client_disbursement', v_d.id, v_from, v_to, jsonb_build_object('ref', v_d.ref));
  END LOOP;
  RETURN app.pay_detail(v_d);
END $$;

-- add_payment_documents(p_id, [{finance_document_id, role, allocation?}], p_idem_key) — more files on a recorded entry
-- (same limits per save: ≤ 8, PDF / image ≤ 4 MB each, ≤ 12 MB; in shared mode an entity invoice names its allocation)
CREATE OR REPLACE FUNCTION public.add_payment_documents(p_id uuid, p_documents jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_d public.client_disbursements; v_replay jsonb; y jsonb; i int; v_f public.finance_documents; v_role text; v_alloc uuid;
        v_bytes bigint := 0; v_seen uuid[] := '{}';
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_d := app.pay_lock(p_id, app.fin_write_roles());
  v_replay := app.idem_begin('add_payment_documents', p_idem_key, jsonb_build_object('id', p_id, 'documents', p_documents), v_d.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_d.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  -- the evidence of an approved entry is what the reviewer approved: it changes only through a correction (back to review)
  IF v_d.review_status = 'approved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'approved_documents'); END IF;
  IF jsonb_typeof(p_documents) IS DISTINCT FROM 'array' OR jsonb_array_length(p_documents) = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'documents'); END IF;
  IF jsonb_array_length(p_documents) > 8 THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'count'); END IF;
  FOR i IN 0 .. jsonb_array_length(p_documents) - 1 LOOP
    y := p_documents -> i;
    IF jsonb_typeof(y) IS DISTINCT FROM 'object' THEN PERFORM app.fail('MRS_INVALID', 'documents'); END IF;
    PERFORM app.only_keys(y, ARRAY['finance_document_id','role','allocation']);
    v_role := app.ptext(y, 'role', 20, true);
    IF NOT app.is_code('pay_document_role', v_role) THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'role'); END IF;
    SELECT * INTO v_f FROM public.finance_documents f WHERE f.id = app.puuid(y, 'finance_document_id');
    IF v_f.id IS NULL OR v_f.org_id <> v_d.org_id OR v_f.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'finance_document_id'); END IF;
    IF v_f.branch_id <> v_d.branch_id THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'branch'); END IF;
    IF coalesce(v_f.mime_type, '') NOT IN ('application/pdf','image/jpeg','image/png','image/webp','image/heic') THEN
      PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'type', v_f.original_name);
    END IF;
    IF v_f.size_bytes > 4194304 THEN PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'size', v_f.original_name); END IF;
    IF v_f.id = ANY (v_seen) OR EXISTS (SELECT 1 FROM public.payment_documents x WHERE x.finance_document_id = v_f.id AND x.removed_at IS NULL) THEN
      PERFORM app.fin_fail('MRS_PAY_DOCUMENT', 'in_use', v_f.original_name);
    END IF;
    v_seen := v_seen || v_f.id;
    v_bytes := v_bytes + v_f.size_bytes;
    IF v_bytes > 12582912 THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'total'); END IF;
    v_alloc := NULL;
    IF y ? 'allocation' AND jsonb_typeof(y -> 'allocation') <> 'null' THEN
      IF v_d.pattern = 'single' THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
      SELECT a.id INTO v_alloc FROM public.disbursement_allocations a WHERE a.disbursement_id = v_d.id
         AND (CASE WHEN jsonb_typeof(y -> 'allocation') = 'number' THEN a.seq = (y ->> 'allocation')::int ELSE a.id::text = (y ->> 'allocation') END);
      IF v_alloc IS NULL THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
    END IF;
    IF v_d.pattern = 'shared' AND v_role = 'entity_invoice' AND v_alloc IS NULL THEN PERFORM app.fail('MRS_PAY_DOCUMENT', 'allocation'); END IF;
    INSERT INTO public.payment_documents (org_id, disbursement_id, allocation_id, finance_document_id, role, created_by)
    VALUES (v_d.org_id, v_d.id, v_alloc, v_f.id, v_role, auth.uid());
  END LOOP;
  RETURN app.idem_finish('add_payment_documents', p_idem_key, app.pay_detail(v_d));
END $$;

-- remove_payment_document(p_link, p_reason) — soft removal of one attachment link (the file itself stays in finance_documents)
CREATE OR REPLACE FUNCTION public.remove_payment_document(p_link uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_x public.payment_documents; v_d public.client_disbursements; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_x FROM public.payment_documents x WHERE x.id = p_link;
  IF v_x.id IS NULL OR NOT app.pay_can_read(v_x.disbursement_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'payment_document'); END IF;
  v_d := app.pay_lock(v_x.disbursement_id, app.fin_write_roles());
  v_reason := app.fin_note(p_reason, 'reason', 500);
  IF v_d.status <> 'recorded' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_d.status); END IF;
  IF v_x.removed_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'removed'); END IF;
  IF v_d.review_status = 'approved' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'approved_documents'); END IF;
  -- the save rules stay true: the last payment proof of a wallet payment without a reference, or of a client-direct
  -- payment with an invoice, cannot be removed (attach the replacement first)
  IF v_x.role = 'payment_proof' AND NOT EXISTS (SELECT 1 FROM public.payment_documents o WHERE o.disbursement_id = v_d.id
       AND o.removed_at IS NULL AND o.role = 'payment_proof' AND o.id <> v_x.id) THEN
    IF coalesce(v_d.sadad_number, v_d.bank_reference, v_d.receipt_no) IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'payment_reference'); END IF;
    IF v_d.movement_type = 'client_direct' AND EXISTS (SELECT 1 FROM public.disbursement_allocations a WHERE a.disbursement_id = v_d.id
         AND a.invoice_norm IS NOT NULL) THEN
      PERFORM app.fail('MRS_REQUIRED', 'payment_proof');
    END IF;
  END IF;
  UPDATE public.payment_documents x SET removed_at = now(), removed_by = auth.uid(), remove_reason = v_reason WHERE x.id = v_x.id;
  RETURN app.pay_detail(v_d);
END $$;

-- get_payment(p_id) → the full entry (finance readers of its branch)
CREATE OR REPLACE FUNCTION public.get_payment(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_d public.client_disbursements;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_d FROM public.client_disbursements d WHERE d.id = p_id;
  IF v_d.id IS NULL OR NOT app.has_branch_role(v_d.org_id, v_d.branch_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'payment'); END IF;
  RETURN app.pay_detail(v_d);
END $$;

-- list_payments(p_org, {q?, movement_type?, pattern?, method?, funding_source?, review_status?, status? recorded|void|all,
--   date_from?, date_to?, transaction_id?, client_id?, beneficiary_party_id?, service_code?, branch_id?, limit? ≤ 200, offset?})
-- → {total, rows [pay_row], totals {paid, expected, difference}} — the caller's finance branches only; recorded by default.
CREATE OR REPLACE FUNCTION public.list_payments(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text; v_lim int; v_off int; v_st text; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['q','movement_type','pattern','method','funding_source','review_status','status','date_from','date_to',
    'transaction_id','client_id','beneficiary_party_id','service_code','branch_id','limit','offset']);
  v_q := app.legacy_search_key(app.ptext(f, 'q', 120));
  v_lim := least(greatest(coalesce(app.pnum(f, 'limit', 1000)::int, 50), 1), 200);
  v_off := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  v_st := coalesce(app.ptext(f, 'status', 10), 'recorded');
  IF v_st NOT IN ('recorded','void','all') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  WITH m AS (
    SELECT d.* FROM public.client_disbursements d
     WHERE d.org_id = p_org AND app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles())
       AND (v_st = 'all' OR d.status = v_st)
       AND (f ->> 'movement_type' IS NULL OR d.movement_type = f ->> 'movement_type')
       AND (f ->> 'pattern' IS NULL OR d.pattern = f ->> 'pattern')
       AND (f ->> 'method' IS NULL OR d.method = f ->> 'method')
       AND (f ->> 'funding_source' IS NULL OR d.funding_source = f ->> 'funding_source')
       AND (f ->> 'review_status' IS NULL OR d.review_status = f ->> 'review_status')
       AND (f ->> 'service_code' IS NULL OR d.service_code = f ->> 'service_code')
       AND (app.puuid(f, 'branch_id') IS NULL OR d.branch_id = app.puuid(f, 'branch_id'))
       AND (app.puuid(f, 'beneficiary_party_id') IS NULL OR d.beneficiary_party_id = app.puuid(f, 'beneficiary_party_id'))
       AND (app.pdate(f, 'date_from') IS NULL OR d.paid_at >= app.pdate(f, 'date_from'))
       AND (app.pdate(f, 'date_to') IS NULL OR d.paid_at <= app.pdate(f, 'date_to'))
       AND (app.puuid(f, 'transaction_id') IS NULL OR EXISTS (SELECT 1 FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id AND a.transaction_id = app.puuid(f, 'transaction_id')))
       AND (app.puuid(f, 'client_id') IS NULL OR EXISTS (SELECT 1 FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id AND a.client_id = app.puuid(f, 'client_id')))
       AND (v_q IS NULL OR position(v_q IN app.legacy_search_key(concat_ws(' ', d.ref, d.claim_no, d.appointment_no, d.sadad_number, d.bank_reference,
              d.receipt_no, d.payer_name, d.beneficiary_name, d.payment_channel, d.service_code, d.notes,
              (SELECT string_agg(concat_ws(' ', t.ref, a.claim_no, a.internal_invoice_no, c.name_ar), ' ') FROM public.disbursement_allocations a
                 JOIN public.transactions t ON t.id = a.transaction_id JOIN public.clients c ON c.id = a.client_id WHERE a.disbursement_id = d.id)))) > 0)
  )
  SELECT jsonb_build_object('total', (SELECT count(*) FROM m),
    'totals', (SELECT jsonb_build_object('paid', coalesce(sum(m.paid_amount), 0), 'expected', coalesce(sum(m.expected_amount), 0),
                                         'difference', coalesce(sum(m.difference), 0)) FROM m),
    'rows', coalesce((SELECT jsonb_agg(app.pay_row(z) ORDER BY z.paid_at DESC, z.created_at DESC)
                        FROM (SELECT * FROM m ORDER BY m.paid_at DESC, m.created_at DESC LIMIT v_lim OFFSET v_off) z), '[]'::jsonb),
    'limit', v_lim, 'offset', v_off)
    INTO v_res;
  RETURN v_res;
END $$;

-- tx_disbursements(p_tx) — the payments panel of a transaction: only THIS transaction's share of each entry
-- → {transaction_id, count, total_share, pending_review, rejected, last_paid_at, items [...]} (recorded entries)
CREATE OR REPLACE FUNCTION public.tx_disbursements(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.fin_tx_read(p_tx);
  WITH s AS (
    SELECT d.*, a.id alloc_id, a.amount share, a.claim_no line_claim, a.supplier_invoice_id, a.client_charge_id
      FROM public.disbursement_allocations a JOIN public.client_disbursements d ON d.id = a.disbursement_id
     WHERE a.transaction_id = v_tx.id AND d.status = 'recorded')
  SELECT jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'client_id', v_tx.client_id,
    'count', (SELECT count(DISTINCT s.id) FROM s),
    'total_share', (SELECT coalesce(sum(s.share), 0) FROM s),
    'by_movement', coalesce((SELECT jsonb_object_agg(z.movement_type, z.amt) FROM (SELECT s.movement_type, sum(s.share) amt FROM s GROUP BY 1) z), '{}'::jsonb),
    'pending_review', (SELECT count(DISTINCT s.id) FROM s WHERE s.review_status IN ('draft','pending')),
    'rejected', (SELECT count(DISTINCT s.id) FROM s WHERE s.review_status = 'rejected'),
    'last_paid_at', (SELECT max(s.paid_at) FROM s),
    'custody_balance', app.custody_balance(v_tx.client_id),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'ref', s.ref, 'allocation_id', s.alloc_id, 'movement_type', s.movement_type,
        'pattern', s.pattern, 'service_code', s.service_code,
        'service_name_ar', (SELECT i.name_ar FROM public.org_service_items i WHERE i.id = s.service_item_id),
        'claim_no', s.line_claim, 'appointment_no', s.appointment_no, 'share', s.share, 'paid_at', s.paid_at, 'method', s.method,
        'funding_source', s.funding_source, 'review_status', s.review_status, 'beneficiary_name', s.beneficiary_name, 'payer_name', s.payer_name,
        'supplier_invoice_id', s.supplier_invoice_id, 'client_charge_id', s.client_charge_id,
        'document_count', (SELECT count(*) FROM public.payment_documents x WHERE x.disbursement_id = s.id AND x.removed_at IS NULL
                             AND (x.allocation_id IS NULL OR x.allocation_id = s.alloc_id)))
      ORDER BY s.paid_at DESC, s.created_at DESC) FROM s), '[]'::jsonb))
    INTO v_res;
  RETURN v_res;
END $$;

-- check_payment_duplicates(p_org, {sadad_number?, bank_reference?, receipt_no?, beneficiary_party_id?, claims?: [{claim_no,
--   internal_invoice_no?}], exclude_id?}) — the form's live check (nothing saved):
-- → {references [{field, id, ref, transaction_ref, amount, paid_at}], invoices [{claim_no, kind taken | other_issuer |
--   existing_invoice | internal_taken, ref?, issuer_name?, supplier_invoice_id?}]}
CREATE OR REPLACE FUNCTION public.check_payment_duplicates(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_refs jsonb := '[]'::jsonb; v_inv jsonb := '[]'::jsonb; v_c jsonb; v_ex uuid;
        v_benef uuid; x jsonb; v_norm text; v_int text; r record;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(p, ARRAY['sadad_number','bank_reference','receipt_no','beneficiary_party_id','claims','exclude_id']);
  v_ex := app.puuid(p, 'exclude_id');
  v_benef := app.puuid(p, 'beneficiary_party_id');
  FOR r IN SELECT * FROM (VALUES ('sadad_number', app.pay_ref_norm('sadad', app.ptext(p, 'sadad_number', 30))),
                                 ('bank_reference', app.pay_ref_norm('bank', app.ptext(p, 'bank_reference', 60))),
                                 ('receipt_no', app.pay_ref_norm('receipt', app.ptext(p, 'receipt_no', 100)))) t(f, v) WHERE t.v IS NOT NULL LOOP
    v_c := app.pay_ref_conflict(p_org, r.f, r.v, v_ex);
    IF v_c IS NOT NULL THEN v_refs := v_refs || v_c; END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'claims') = 'array' THEN
    FOR x IN SELECT e FROM jsonb_array_elements(p -> 'claims') e LIMIT 50 LOOP
      v_norm := app.pay_inv_key(x ->> 'claim_no');
      v_int := app.pay_int_key(x ->> 'internal_invoice_no');
      -- rows of a branch the caller cannot read: only the kind (taken / other issuer / …), never the ref, ids or issuer
      IF v_norm IS NOT NULL THEN
        FOR r IN SELECT d.id, d.ref, a.beneficiary_party_id, pa.name_ar, app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles()) vis
                   FROM public.disbursement_allocations a
                   JOIN public.client_disbursements d ON d.id = a.disbursement_id LEFT JOIN public.parties pa ON pa.id = a.beneficiary_party_id
                  WHERE a.org_id = p_org AND a.voided_at IS NULL AND a.invoice_norm = v_norm AND d.id IS DISTINCT FROM v_ex LIMIT 5 LOOP
          v_inv := v_inv || jsonb_build_object('claim_no', x ->> 'claim_no', 'kind', CASE WHEN r.beneficiary_party_id = v_benef THEN 'taken' ELSE 'other_issuer' END,
                                               'id', CASE WHEN r.vis THEN r.id END, 'ref', CASE WHEN r.vis THEN r.ref END,
                                               'issuer_name', CASE WHEN r.vis THEN r.name_ar END, 'hidden', NOT r.vis);
        END LOOP;
        FOR r IN SELECT si.id, si.supplier_id, pa.name_ar, app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()) vis
                   FROM public.supplier_invoices si JOIN public.parties pa ON pa.id = si.supplier_id
                  WHERE si.org_id = p_org AND si.status <> 'void' AND si.doc_type = 'invoice' AND app.pay_inv_key(si.invoice_number) = v_norm
                    AND (v_ex IS NULL OR si.created_by_disbursement_id IS DISTINCT FROM v_ex)
                    AND NOT EXISTS (SELECT 1 FROM public.disbursement_allocations a WHERE a.supplier_invoice_id = si.id AND a.voided_at IS NULL) LIMIT 5 LOOP
          v_inv := v_inv || jsonb_build_object('claim_no', x ->> 'claim_no', 'kind', CASE WHEN r.supplier_id = v_benef THEN 'existing_invoice' ELSE 'other_issuer' END,
                                               'supplier_invoice_id', CASE WHEN r.vis THEN r.id END, 'issuer_name', CASE WHEN r.vis THEN r.name_ar END,
                                               'hidden', NOT r.vis);
        END LOOP;
      END IF;
      -- the internal number: invoices and live register lines; a correction does not see its own entry (exclude_id)
      IF v_int IS NOT NULL THEN
        FOR r IN SELECT z.id, z.name_ar, z.vis FROM (
                   SELECT si.id, pa.name_ar, app.has_branch_role(si.org_id, si.branch_id, app.fin_read_roles()) vis, 1 o
                     FROM public.supplier_invoices si JOIN public.parties pa ON pa.id = si.supplier_id
                    WHERE si.org_id = p_org AND si.status <> 'void' AND si.internal_invoice_no IS NOT NULL
                      AND app.pay_int_key(si.internal_invoice_no) = v_int AND (v_ex IS NULL OR si.created_by_disbursement_id IS DISTINCT FROM v_ex)
                      AND NOT EXISTS (SELECT 1 FROM public.disbursement_allocations a WHERE a.supplier_invoice_id = si.id AND a.disbursement_id = v_ex)
                   UNION ALL
                   SELECT a.supplier_invoice_id, pa.name_ar, app.has_branch_role(d.org_id, d.branch_id, app.fin_read_roles()), 2
                     FROM public.disbursement_allocations a JOIN public.client_disbursements d ON d.id = a.disbursement_id
                     LEFT JOIN public.parties pa ON pa.id = a.beneficiary_party_id
                    WHERE a.org_id = p_org AND a.voided_at IS NULL AND a.internal_invoice_no IS NOT NULL
                      AND app.pay_int_key(a.internal_invoice_no) = v_int AND d.id IS DISTINCT FROM v_ex) z
                  ORDER BY z.o LIMIT 1 LOOP
          v_inv := v_inv || jsonb_build_object('claim_no', x ->> 'claim_no', 'internal_invoice_no', x ->> 'internal_invoice_no', 'kind', 'internal_taken',
                                               'supplier_invoice_id', CASE WHEN r.vis THEN r.id END, 'issuer_name', CASE WHEN r.vis THEN r.name_ar END,
                                               'hidden', NOT r.vis);
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('references', v_refs, 'invoices', v_inv);
END $$;

-- match_payment_transaction(p_org, {bl_number?, declaration_number?, container_numbers?: [..], appointment_no?, client_id?})
-- → {candidates [{transaction_id, ref, client_id, client_name, branch_id, matched_by [..], score}], unique_transaction_id}
-- unique_transaction_id is set ONLY when exactly one transaction matches (the form may pre-select it; nothing is saved).
CREATE OR REPLACE FUNCTION public.match_payment_transaction(p_org uuid, p_hints jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE h jsonb := coalesce(p_hints, '{}'::jsonb); v_bl text; v_decl text; v_ctrs text[]; v_tas text; v_client uuid; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(h, ARRAY['bl_number','declaration_number','container_numbers','appointment_no','client_id']);
  v_bl := nullif(upper(regexp_replace(app.to_western(coalesce(h ->> 'bl_number', '')), '[[:space:]]', '', 'g')), '');
  v_decl := nullif(upper(regexp_replace(app.to_western(coalesce(h ->> 'declaration_number', '')), '[[:space:]]', '', 'g')), '');
  v_tas := app.norm_tas(h ->> 'appointment_no');
  v_client := app.puuid(h, 'client_id');
  IF jsonb_typeof(h -> 'container_numbers') = 'array' THEN
    SELECT array_agg(DISTINCT upper(regexp_replace(e, '[^A-Za-z0-9]', '', 'g'))) INTO v_ctrs FROM jsonb_array_elements_text(h -> 'container_numbers') e;
  END IF;
  WITH c AS (
    SELECT t.id, t.ref, t.client_id, t.branch_id,
           array_remove(ARRAY[
             CASE WHEN v_bl IS NOT NULL AND (upper(t.bl_number) = v_bl OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                                                                                   WHERE tb.transaction_id = t.id AND b.bl_number = v_bl)) THEN 'bl_number' END,
             CASE WHEN v_decl IS NOT NULL AND EXISTS (SELECT 1 FROM public.customs_declarations cd WHERE cd.transaction_id = t.id AND cd.declaration_no = v_decl
                                                        AND cd.status NOT IN ('cancelled','replaced')) THEN 'declaration_number' END,
             CASE WHEN v_ctrs IS NOT NULL AND EXISTS (SELECT 1 FROM public.containers k WHERE k.transaction_id = t.id AND k.container_no = ANY (v_ctrs)) THEN 'container_numbers' END,
             CASE WHEN v_tas IS NOT NULL AND EXISTS (SELECT 1 FROM public.port_appointments pa WHERE pa.transaction_id = t.id
                                                       AND (pa.appointment_no = v_tas OR pa.booking_ref = v_tas)) THEN 'appointment_no' END], NULL) AS by
      FROM public.transactions t
     WHERE t.org_id = p_org AND t.cancelled_at IS NULL AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())
       AND (v_client IS NULL OR t.client_id = v_client)
       AND (v_bl IS NOT NULL OR v_decl IS NOT NULL OR v_ctrs IS NOT NULL OR v_tas IS NOT NULL)),
  m AS (SELECT * FROM c WHERE cardinality(c.by) > 0)
  SELECT jsonb_build_object(
    'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object('transaction_id', m.id, 'ref', m.ref, 'client_id', m.client_id,
        'client_name', (SELECT cl.name_ar FROM public.clients cl WHERE cl.id = m.client_id), 'branch_id', m.branch_id,
        'matched_by', to_jsonb(m.by), 'score', cardinality(m.by)) ORDER BY cardinality(m.by) DESC, m.ref) FROM (SELECT * FROM m LIMIT 20) m), '[]'::jsonb),
    'unique_transaction_id', CASE WHEN (SELECT count(*) FROM m) = 1 THEN (SELECT m.id FROM m) END)
    INTO v_res;
  RETURN v_res;
END $$;

-- ---------------------------------------------------------------------
-- 4. RPCs — client custody (عهدة العملاء)
-- ---------------------------------------------------------------------
-- save_custody_entry({client_id, kind deposit|deduction|refund, amount, entry_date, transaction_id? (required for a deduction),
--   disbursement_id? (deduction only: a recorded payment of that transaction), branch_id? (when no transaction), reference?,
--   notes?}, p_idem_key) → the entry + {balance} — finance writers; per-client advisory lock; the balance never goes negative.
CREATE OR REPLACE FUNCTION public.save_custody_entry(p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_client public.clients; v_kind text; v_amount numeric; v_date date; v_tx public.transactions;
        v_branch uuid; v_d public.client_disbursements; v_share numeric; v_bal numeric; v_replay jsonb; v_e public.client_custody_entries;
        v_org uuid; v_seq bigint;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['client_id','kind','amount','entry_date','transaction_id','disbursement_id','branch_id','reference','notes','idempotencyKey']);
  SELECT * INTO v_client FROM public.clients c WHERE c.id = app.puuid(p, 'client_id');
  IF v_client.id IS NULL OR NOT app.is_staff(v_client.org_id) THEN PERFORM app.fail(CASE WHEN app.puuid(p, 'client_id') IS NULL THEN 'MRS_REQUIRED' ELSE 'MRS_NOT_FOUND' END, 'client'); END IF;
  v_org := v_client.org_id;
  IF NOT app.has_role(v_org, app.fin_write_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'finance'); END IF;
  v_replay := app.idem_begin('save_custody_entry', p_idem_key, p - 'idempotencyKey', v_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_kind := app.ptext(p, 'kind', 20, true);
  IF NOT app.is_code('custody_entry_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_amount := app.fin_money(p, 'amount');
  IF v_amount IS NULL OR v_amount <= 0 THEN PERFORM app.fail('MRS_INVALID', 'amount'); END IF;
  v_date := app.pdate(p, 'entry_date');
  IF v_date IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'entry_date'); END IF;
  IF v_date > (now() AT TIME ZONE 'Asia/Riyadh')::date OR v_date < DATE '2000-01-01' THEN PERFORM app.fail('MRS_INVALID', 'entry_date'); END IF;
  IF app.puuid(p, 'transaction_id') IS NOT NULL THEN
    v_tx := app.g3_lock_tx(app.puuid(p, 'transaction_id'), app.fin_write_roles());
    IF v_tx.org_id <> v_org THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
    IF v_tx.client_id <> v_client.id THEN PERFORM app.fail('MRS_CUSTODY_LINK', 'client_mismatch'); END IF;
    v_branch := v_tx.branch_id;
    IF app.puuid(p, 'branch_id') IS NOT NULL AND app.puuid(p, 'branch_id') <> v_branch THEN PERFORM app.fail('MRS_INVALID', 'branch_id'); END IF;
  ELSE
    IF v_kind = 'deduction' THEN PERFORM app.fail('MRS_CUSTODY_LINK', 'transaction_required'); END IF;
    v_branch := app.puuid(p, 'branch_id');
    IF v_branch IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'branch_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = v_org) THEN PERFORM app.fail('MRS_INVALID', 'branch_id'); END IF;
    IF NOT app.has_branch_role(v_org, v_branch, app.fin_write_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  END IF;
  IF v_kind = 'deduction' THEN
    IF app.puuid(p, 'disbursement_id') IS NULL THEN PERFORM app.fail('MRS_CUSTODY_LINK', 'payment_required'); END IF;
    SELECT * INTO v_d FROM public.client_disbursements d WHERE d.id = app.puuid(p, 'disbursement_id') AND d.org_id = v_org FOR SHARE;
    IF v_d.id IS NULL THEN PERFORM app.fail('MRS_CUSTODY_LINK', 'payment_required'); END IF;
    IF v_d.status <> 'recorded' THEN PERFORM app.fail('MRS_CUSTODY_LINK', 'payment_void'); END IF;
    SELECT coalesce(sum(a.amount), 0) INTO v_share FROM public.disbursement_allocations a WHERE a.disbursement_id = v_d.id AND a.transaction_id = v_tx.id;
    IF v_share <= 0 THEN PERFORM app.fail('MRS_CUSTODY_LINK', 'payment_not_in_transaction'); END IF;
    IF v_amount > v_share THEN PERFORM app.fin_fail('MRS_CUSTODY_LINK', 'exceeds_payment', v_share::text); END IF;
  ELSIF app.puuid(p, 'disbursement_id') IS NOT NULL THEN
    PERFORM app.fail('MRS_INVALID', 'disbursement_id');
  END IF;
  PERFORM app.custody_lock(v_client.id);
  IF v_kind = 'deduction' AND EXISTS (SELECT 1 FROM public.client_custody_entries e WHERE e.org_id = v_org AND e.client_id = v_client.id
       AND e.transaction_id = v_tx.id AND e.disbursement_id = v_d.id AND e.kind = 'deduction' AND e.status = 'active') THEN
    PERFORM app.fail('MRS_CUSTODY_LINK', 'duplicate_deduction');
  END IF;
  v_bal := app.custody_balance(v_client.id);
  IF v_kind <> 'deposit' AND v_bal - v_amount < 0 THEN PERFORM app.fin_fail('MRS_CUSTODY_NEGATIVE', v_kind, v_bal::text); END IF;
  v_seq := nextval('public.client_custody_entries_seq');
  INSERT INTO public.client_custody_entries (org_id, branch_id, client_id, seq, ref, kind, amount, entry_date, transaction_id, disbursement_id,
    reference, notes, created_by)
  VALUES (v_org, v_branch, v_client.id, v_seq, 'CUS-' || lpad(v_seq::text, 6, '0'), v_kind, v_amount, v_date,
    v_tx.id, v_d.id, app.ptext(p, 'reference', 120), app.ptext(p, 'notes', 2000), auth.uid())
  RETURNING * INTO v_e;
  IF v_tx.id IS NOT NULL THEN
    PERFORM app.fin_event(v_org, v_tx.id, 'custody_' || v_kind, 'client_custody_entry', v_e.id, NULL, 'active', jsonb_build_object('ref', v_e.ref));
  END IF;
  RETURN app.idem_finish('save_custody_entry', p_idem_key, app.custody_json(v_e) || jsonb_build_object('balance', app.custody_balance(v_client.id)));
END $$;

-- void_custody_entry(p_id, p_reason ≥ 3 chars) — finance approver; voiding a deposit / refund is re-checked under the lock:
-- a deposit whose void would make the balance negative is refused (MRS_CUSTODY_NEGATIVE; legacy bug fixed)
CREATE OR REPLACE FUNCTION public.void_custody_entry(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_e public.client_custody_entries; v_reason text; v_bal numeric;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_e FROM public.client_custody_entries e WHERE e.id = p_id;
  IF v_e.id IS NULL OR NOT app.has_branch_role(v_e.org_id, v_e.branch_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'custody_entry'); END IF;
  IF NOT app.has_branch_role(v_e.org_id, v_e.branch_id, app.fin_approve_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_reason := app.fin_note(p_reason, 'reason', 500);
  IF char_length(v_reason) < 3 THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  PERFORM app.custody_lock(v_e.client_id);
  SELECT * INTO v_e FROM public.client_custody_entries e WHERE e.id = p_id FOR UPDATE;
  IF v_e.status <> 'active' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_e.status); END IF;
  v_bal := app.custody_balance(v_e.client_id);
  IF v_bal - v_e.signed_amount < 0 THEN PERFORM app.fin_fail('MRS_CUSTODY_NEGATIVE', 'void_' || v_e.kind, v_bal::text); END IF;
  UPDATE public.client_custody_entries e SET status = 'void', void_reason = v_reason, voided_by = auth.uid(), voided_at = now()
   WHERE e.id = v_e.id RETURNING * INTO v_e;
  IF v_e.transaction_id IS NOT NULL THEN
    PERFORM app.fin_event(v_e.org_id, v_e.transaction_id, 'custody_voided', 'client_custody_entry', v_e.id, 'active', 'void', jsonb_build_object('ref', v_e.ref));
  END IF;
  RETURN app.custody_json(v_e) || jsonb_build_object('balance', app.custody_balance(v_e.client_id));
END $$;

-- list_custody_entries(p_org, {client_id?, kind?, status? active|void|all, transaction_id?, date_from?, date_to?, q?, limit?, offset?})
-- → {total, rows [entry + client_name, transaction_ref, payment_ref]} — the caller's finance branches
CREATE OR REPLACE FUNCTION public.list_custody_entries(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text; v_lim int; v_off int; v_st text; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['client_id','kind','status','transaction_id','date_from','date_to','q','limit','offset']);
  v_q := app.legacy_search_key(app.ptext(f, 'q', 120));
  v_lim := least(greatest(coalesce(app.pnum(f, 'limit', 1000)::int, 100), 1), 500);
  v_off := coalesce(app.pnum(f, 'offset', 1000000)::int, 0);
  v_st := coalesce(app.ptext(f, 'status', 10), 'all');
  IF v_st NOT IN ('active','void','all') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  WITH m AS (
    SELECT e.* FROM public.client_custody_entries e
     WHERE e.org_id = p_org AND app.has_branch_role(e.org_id, e.branch_id, app.fin_read_roles())
       AND (v_st = 'all' OR e.status = v_st)
       AND (app.puuid(f, 'client_id') IS NULL OR e.client_id = app.puuid(f, 'client_id'))
       AND (f ->> 'kind' IS NULL OR e.kind = f ->> 'kind')
       AND (app.puuid(f, 'transaction_id') IS NULL OR e.transaction_id = app.puuid(f, 'transaction_id'))
       AND (app.pdate(f, 'date_from') IS NULL OR e.entry_date >= app.pdate(f, 'date_from'))
       AND (app.pdate(f, 'date_to') IS NULL OR e.entry_date <= app.pdate(f, 'date_to'))
       AND (v_q IS NULL OR position(v_q IN app.legacy_search_key(concat_ws(' ', e.ref, e.reference, e.notes,
              (SELECT c.name_ar FROM public.clients c WHERE c.id = e.client_id), (SELECT t.ref FROM public.transactions t WHERE t.id = e.transaction_id),
              (SELECT d.ref FROM public.client_disbursements d WHERE d.id = e.disbursement_id)))) > 0))
  SELECT jsonb_build_object('total', (SELECT count(*) FROM m),
    'rows', coalesce((SELECT jsonb_agg(app.custody_json(z) ORDER BY z.entry_date DESC, z.created_at DESC)
                        FROM (SELECT * FROM m ORDER BY m.entry_date DESC, m.created_at DESC LIMIT v_lim OFFSET v_off) z), '[]'::jsonb),
    'limit', v_lim, 'offset', v_off)
    INTO v_res;
  RETURN v_res;
END $$;

-- custody_balances(p_org, {q?, nonzero?}) → {rows [{client_id, client_name, balance, total_deposits, total_deductions, total_refunds,
--   entry_count, last_entry_date}], total_balance} — org-wide figures per client (a finance reader anywhere in the org)
CREATE OR REPLACE FUNCTION public.custody_balances(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['q','nonzero']);
  v_q := app.legacy_search_key(app.ptext(f, 'q', 120));
  WITH b AS (
    SELECT e.client_id, c.name_ar, sum(e.signed_amount) bal,
           coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deposit'), 0) dep, coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deduction'), 0) ded,
           coalesce(sum(e.amount) FILTER (WHERE e.kind = 'refund'), 0) ref, count(*) n, max(e.entry_date) last
      FROM public.client_custody_entries e JOIN public.clients c ON c.id = e.client_id
     WHERE e.org_id = p_org AND e.status = 'active'
       AND (v_q IS NULL OR position(v_q IN app.legacy_search_key(c.name_ar)) > 0)
     GROUP BY e.client_id, c.name_ar)
  SELECT jsonb_build_object('rows', coalesce((SELECT jsonb_agg(jsonb_build_object('client_id', b.client_id, 'client_name', b.name_ar, 'balance', b.bal,
           'total_deposits', b.dep, 'total_deductions', b.ded, 'total_refunds', b.ref, 'entry_count', b.n, 'last_entry_date', b.last)
           ORDER BY b.bal DESC, b.name_ar) FROM b WHERE NOT app.pbool(f, 'nonzero') OR b.bal <> 0), '[]'::jsonb),
         'total_balance', (SELECT coalesce(sum(b.bal), 0) FROM b))
    INTO v_res;
  RETURN v_res;
END $$;

-- client_custody_balance(p_client) → {client_id, balance, total_deposits, total_deductions, total_refunds, entry_count,
--   last_entry_date} — the client page (finance readers of the org; NULL figures never: 0 when no entry)
CREATE OR REPLACE FUNCTION public.client_custody_balance(p_client uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.clients; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.clients c WHERE c.id = p_client;
  IF v_c.id IS NULL OR NOT app.is_staff(v_c.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'client'); END IF;
  PERFORM app.fin_org_read(v_c.org_id);
  SELECT jsonb_build_object('client_id', v_c.id, 'client_name', v_c.name_ar, 'balance', coalesce(sum(e.signed_amount), 0),
           'total_deposits', coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deposit'), 0),
           'total_deductions', coalesce(sum(e.amount) FILTER (WHERE e.kind = 'deduction'), 0),
           'total_refunds', coalesce(sum(e.amount) FILTER (WHERE e.kind = 'refund'), 0),
           'entry_count', count(e.id), 'last_entry_date', max(e.entry_date))
    INTO v_res FROM public.client_custody_entries e WHERE e.client_id = v_c.id AND e.status = 'active';
  RETURN v_res;
END $$;

-- ---------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_pay_before ON public.client_disbursements;
CREATE TRIGGER trg_pay_before BEFORE INSERT ON public.client_disbursements FOR EACH ROW EXECUTE FUNCTION app.tg_pay_before();
DROP TRIGGER IF EXISTS trg_guard ON public.client_disbursements;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.client_disbursements FOR EACH ROW EXECUTE FUNCTION app.tg_pay_guard();
DROP TRIGGER IF EXISTS trg_pay_sum ON public.client_disbursements;
CREATE CONSTRAINT TRIGGER trg_pay_sum AFTER INSERT ON public.client_disbursements DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.tg_pay_sum();
DROP TRIGGER IF EXISTS trg_pay_sum ON public.disbursement_allocations;
CREATE CONSTRAINT TRIGGER trg_pay_sum AFTER INSERT ON public.disbursement_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.tg_pay_sum();
DROP TRIGGER IF EXISTS trg_guard ON public.disbursement_allocations;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.disbursement_allocations FOR EACH ROW EXECUTE FUNCTION app.tg_pay_alloc_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.payment_documents;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.payment_documents FOR EACH ROW EXECUTE FUNCTION app.tg_pay_doc_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.client_custody_entries;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.client_custody_entries FOR EACH ROW EXECUTE FUNCTION app.tg_custody_guard();
DROP TRIGGER IF EXISTS trg_custody_balance ON public.client_custody_entries;
CREATE TRIGGER trg_custody_balance AFTER INSERT OR UPDATE ON public.client_custody_entries FOR EACH ROW EXECUTE FUNCTION app.tg_custody_balance();
DROP TRIGGER IF EXISTS trg_touch ON public.client_disbursements;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.client_disbursements FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DO $trg$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_disbursements','disbursement_allocations','payment_documents','client_custody_entries'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
END $trg$;

-- ---------------------------------------------------------------------
-- 5. conversion lists (20261121000100 §6, re-created): + the 4 tables of this file (test rows, deleted) and their
--    no-delete guards
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.convert_delete_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    -- intake / clients / access
    'public.service_requests', 'public.clients', 'public.client_aliases', 'public.client_users', 'public.invitations',
    'public.idempotency_keys', 'public.import_batches', 'public.import_rows', 'public.contact_messages',
    -- operations
    'public.transactions', 'public.transaction_events', 'public.transaction_bls', 'public.bills_of_lading',
    'public.customs_declarations', 'public.containers', 'public.documents', 'public.document_extractions',
    'public.document_matches',
    'public.doc_batches', 'public.doc_batch_documents', 'public.transaction_shipment_data',
    'public.shipment_invoice_items', 'public.shipment_packing_items',
    'public.declaration_approvals', 'public.declaration_items', 'public.hs_reference',
    'public.parties', 'public.party_ports',
    'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
    'public.appointment_drafts', 'public.appointment_draft_cards', 'public.empty_return_proofs',
    'public.demurrage_cases', 'public.operational_exceptions', 'public.operational_alerts',
    -- costs (G4)
    'public.cost_accruals', 'public.cost_adjustments', 'public.cost_allocations', 'public.client_charges',
    'public.charge_collections', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.supplier_payments',
    'public.finance_documents',
    'public.client_disbursements', 'public.disbursement_allocations', 'public.payment_documents',                -- PAY
    'public.client_custody_entries',                                                                              -- PAY
    -- billing (G5)
    'public.billing_intents', 'public.billing_intent_lines', 'public.billing_review_items', 'public.billing_sync_jobs',
    'public.billing_sync_attempts', 'public.daftra_client_links', 'public.daftra_mock_accounts',
    -- inbox (G6b)
    'public.msg_threads', 'public.msg_messages', 'public.msg_message_events', 'public.msg_attachments',
    'public.msg_extractions', 'public.msg_summaries', 'public.msg_classifications', 'public.msg_ai_runs',
    'public.msg_replies', 'public.msg_reply_versions', 'public.msg_reply_approvals', 'public.msg_outbound',
    'public.msg_delivery_events', 'public.msg_jobs', 'public.msg_job_attempts', 'public.msg_thread_links',
    'public.msg_contacts', 'public.msg_contact_addresses', 'public.msg_contact_authorizations', 'public.msg_mock_mailboxes'
  ]::text[]
$$;

CREATE OR REPLACE FUNCTION app.convert_delete_guards() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.transaction_events:trg_append_only', 'public.charge_collections:trg_append_only',
    'public.supplier_payments:trg_append_only', 'public.billing_sync_attempts:trg_append_only',
    'public.msg_ai_runs:trg_append_only', 'public.msg_attachments:trg_append_only',
    'public.msg_classifications:trg_append_only', 'public.msg_delivery_events:trg_append_only',
    'public.msg_extractions:trg_append_only', 'public.msg_job_attempts:trg_append_only',
    'public.msg_message_events:trg_append_only', 'public.msg_messages:trg_append_only',
    'public.msg_outbound:trg_append_only', 'public.msg_reply_approvals:trg_append_only',
    'public.msg_reply_versions:trg_append_only', 'public.msg_summaries:trg_append_only',
    'public.msg_thread_links:trg_append_only',
    'public.msg_contact_addresses:trg_no_delete', 'public.msg_contact_authorizations:trg_no_delete',
    'public.msg_contacts:trg_no_delete', 'public.msg_jobs:trg_no_delete', 'public.msg_replies:trg_no_delete',
    'public.msg_threads:trg_no_delete',
    'public.document_matches:trg_no_delete',
    'public.doc_batches:trg_no_delete', 'public.doc_batch_documents:trg_no_delete',
    'public.transaction_shipment_data:trg_no_delete', 'public.shipment_invoice_items:trg_no_delete',
    'public.shipment_packing_items:trg_no_delete',
    'public.declaration_approvals:trg_no_delete', 'public.declaration_items:trg_no_delete',
    'public.hs_reference:trg_no_delete',
    'public.appointment_drafts:trg_no_delete', 'public.appointment_draft_cards:trg_no_delete',
    'public.empty_return_proofs:trg_no_delete',
    'public.client_disbursements:trg_no_delete', 'public.disbursement_allocations:trg_no_delete',             -- PAY
    'public.payment_documents:trg_no_delete', 'public.client_custody_entries:trg_no_delete'                    -- PAY
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 6. RLS, policies, grants, function privileges — finance read roles only (branch scope); clients: nothing
-- ---------------------------------------------------------------------
ALTER TABLE public.client_disbursements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_custody_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_disbursements, public.disbursement_allocations, public.payment_documents, public.client_custody_entries,
  public.client_custody_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_disbursements, public.disbursement_allocations, public.payment_documents, public.client_custody_entries,
  public.client_custody_balances TO authenticated;
REVOKE ALL ON SEQUENCE public.client_disbursements_seq, public.client_custody_entries_seq FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS client_disbursements_select ON public.client_disbursements;
CREATE POLICY client_disbursements_select ON public.client_disbursements FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.fin_read_roles()));
DROP POLICY IF EXISTS disbursement_allocations_select ON public.disbursement_allocations;
CREATE POLICY disbursement_allocations_select ON public.disbursement_allocations FOR SELECT TO authenticated
  USING (app.pay_can_read(disbursement_id));
DROP POLICY IF EXISTS payment_documents_select ON public.payment_documents;
CREATE POLICY payment_documents_select ON public.payment_documents FOR SELECT TO authenticated
  USING (app.pay_can_read(disbursement_id));
DROP POLICY IF EXISTS client_custody_entries_select ON public.client_custody_entries;
CREATE POLICY client_custody_entries_select ON public.client_custody_entries FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, app.fin_read_roles()));

-- policy helper (RLS runs it as the caller)
REVOKE EXECUTE ON FUNCTION app.pay_can_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.pay_can_read(uuid) TO authenticated;
-- the CHECK / trigger helpers stay executable where the rows are written (SECURITY DEFINER RPCs run as the owner)
REVOKE EXECUTE ON FUNCTION app.pay_ref_norm(text, text), app.pay_inv_key(text), app.pay_int_key(text), app.pay_is_author(uuid, uuid), app.pay_org_payer(uuid), app.pay_lock(uuid, text[]),
  app.pay_row(public.client_disbursements), app.pay_detail(public.client_disbursements), app.pay_ref_conflict(uuid, text, text, uuid),
  app.pay_locked(public.client_disbursements), app.pay_void_core(public.client_disbursements, text, text),
  app.pay_record(jsonb, public.client_disbursements), app.custody_balance(uuid), app.custody_lock(uuid),
  app.custody_json(public.client_custody_entries), app.tg_pay_before(), app.tg_pay_guard(), app.tg_pay_alloc_guard(), app.tg_pay_doc_guard(),
  app.tg_pay_sum(), app.tg_custody_guard(), app.tg_custody_balance()
FROM PUBLIC, anon, authenticated, service_role;
-- re-created G4 trigger function: as in 20261104000100
REVOKE EXECUTE ON FUNCTION app.tg_payment_totals() FROM PUBLIC, anon, authenticated;
-- the conversion lists stay SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_delete_guards() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only (each checks the finance roles itself)
REVOKE ALL ON FUNCTION public.record_payment_bundle(jsonb, uuid), public.correct_payment(uuid, jsonb, text, uuid),
  public.void_payment(uuid, text), public.review_payment(uuid, text, text), public.add_payment_documents(uuid, jsonb, uuid),
  public.remove_payment_document(uuid, text), public.get_payment(uuid), public.list_payments(uuid, jsonb), public.tx_disbursements(uuid),
  public.check_payment_duplicates(uuid, jsonb), public.match_payment_transaction(uuid, jsonb), public.save_custody_entry(jsonb, uuid),
  public.void_custody_entry(uuid, text), public.list_custody_entries(uuid, jsonb), public.custody_balances(uuid, jsonb),
  public.client_custody_balance(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_payment_bundle(jsonb, uuid), public.correct_payment(uuid, jsonb, text, uuid),
  public.void_payment(uuid, text), public.review_payment(uuid, text, text), public.add_payment_documents(uuid, jsonb, uuid),
  public.remove_payment_document(uuid, text), public.get_payment(uuid), public.list_payments(uuid, jsonb), public.tx_disbursements(uuid),
  public.check_payment_duplicates(uuid, jsonb), public.match_payment_transaction(uuid, jsonb), public.save_custody_entry(jsonb, uuid),
  public.void_custody_entry(uuid, text), public.list_custody_entries(uuid, jsonb), public.custody_balances(uuid, jsonb),
  public.client_custody_balance(uuid)
TO authenticated;
-- re-created functions (tg_payment_totals, convert_delete_tables, convert_delete_guards): CREATE OR REPLACE keeps their
-- existing privileges; restated above
