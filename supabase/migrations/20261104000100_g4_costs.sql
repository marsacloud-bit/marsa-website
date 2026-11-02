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
