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
