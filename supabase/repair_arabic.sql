-- Marsa staging — REPAIR for Arabic text garbled by a non-UTF-8 clipboard paste.
-- Safe to run more than once. Runs as a single transaction.
BEGIN;
DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;

-- 1) status labels (Arabic captions)
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

-- 2) functions whose logic contains Arabic (Arabic-Indic digits, Arabic comma, 'فرد')
CREATE OR REPLACE FUNCTION app.to_western(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(p, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')
$$;

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

-- 3) Arabic test data from seed.sql

UPDATE public.organizations SET name_ar='مؤسسة البحر الأزرق (بيئة تجريبية)', settings = settings || '{"note": "بيانات اختبار فقط — ليست بيئة إنتاج"}'::jsonb WHERE id='0b5e0000-0000-4000-8000-000000000001';
UPDATE public.branches SET name_ar='فرع جدة', city='جدة' WHERE id='0b5e0000-0000-4000-8000-000000000011';
UPDATE public.branches SET name_ar='فرع الدمام', city='الدمام' WHERE id='0b5e0000-0000-4000-8000-000000000012';
UPDATE public.clients SET name_ar='شركة الاختبار الأولى للتجارة', contact_person='عميل تجريبي', notes='بيانات اختبار',
  national_address='{"building_no":"0000","street":"شارع تجريبي","district":"حي تجريبي","city":"جدة","postal_code":"00000","additional_no":"0000"}'::jsonb
  WHERE id='0b5e0000-0000-4000-8000-000000000101';
UPDATE public.clients SET name_ar='مؤسسة التجربة الثانية', contact_person='عميل تجريبي ٢', notes='بيانات اختبار' WHERE id='0b5e0000-0000-4000-8000-000000000102';
UPDATE public.clients SET name_ar='عميل فرد تجريبي', notes='بيانات اختبار' WHERE id='0b5e0000-0000-4000-8000-000000000103';
UPDATE public.transactions SET port_of_discharge='ميناء جدة الإسلامي', country='الصين', goods_description='قطع غيار تجريبية', shipping_line='خط ملاحي تجريبي', notes='معاملة اختبار' WHERE id='0b5e0000-0000-4000-8000-000000000201';
UPDATE public.transactions SET port_of_discharge='ميناء الملك عبدالعزيز بالدمام', country='الهند', goods_description='مواد غذائية تجريبية', shipping_line='خط ملاحي تجريبي', notes='معاملة اختبار' WHERE id='0b5e0000-0000-4000-8000-000000000202';
UPDATE public.transactions SET port_of_discharge='مطار الملك عبدالعزيز الدولي', country='ألمانيا', goods_description='أجهزة تجريبية', notes='معاملة اختبار' WHERE id='0b5e0000-0000-4000-8000-000000000203';
UPDATE public.service_requests SET full_name='مقدم طلب تجريبي', company='شركة طلب تجريبية', country='الصين', port='ميناء جدة الإسلامي', goods='بضاعة تجريبية للاختبار', notes='طلب اختبار' WHERE id='0b5e0000-0000-4000-8000-000000000401';

COMMENT ON TABLE public.organizations IS 'Tenant (مؤسسة). STAGING: environment must stay ''staging'' in this project.';

-- 4) check: should print جديد and مؤسسة البحر الأزرق (بيئة تجريبية)
COMMIT;
SELECT (SELECT label_ar FROM public.status_labels WHERE domain='request_status' AND code='new') AS label_check,
       (SELECT name_ar FROM public.organizations WHERE slug='blue-sea') AS org_check,
       app.to_western('٠٥٥١٢٣٤٥٦٧') AS digits_check;
