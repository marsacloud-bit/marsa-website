-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261117000100 — legacy port, step 1: data model foundation (نموذج البيانات الأساسي)
-- for the features of the legacy Apps Script system (docs/online/LEGACY_PORT_PLAN_AR.md, docs/online/LEGACY_CORE_AR.md).
-- Builds on doc_match (20261116000100). Adds data + rules only; the screens come in step 2.
--   P. preflight (doc_match applied, document_matches present) + schema_versions row
--   0. dictionaries status_labels: transaction_type, cargo_unit_type, transport_mode, customs_port_kind,
--                   declaration_type, declaration_status (+ 4 Fasah stages, re-sorted, codes kept), client_port_category,
--                   client_source, alias_status, fin_payment_method (+ sadad, mada, fasah_wallet, dry_port_wallet),
--                   fin_funding_source (10), fin_service (+ gate_in_appointment, gate_out_appointment)
--   1. helpers      app.legacy_search_key(text)      legacy normalizeSearch_ (lower, western digits, Arabic folding,
--                                                    no diacritics / spaces / - _ / \ .)
--                   app.norm_declaration_status(text) → draft … released / NULL (Fasah stage names + legacy aliases)
--                   app.norm_declaration_type(text)   → import / export / clearance / NULL (استيراد / تصدير / تصفية)
--                   app.norm_tas(text)                → TAS<≥ 8 digits> / NULL (bidi marks stripped, RTL '…TAS' fixed)
--                   app.norm_sa_phone(text, landline) → 05XXXXXXXX (/ 01[1-7]XXXXXXX) / NULL
--                   app.norm_chassis(text)            → A-Z0-9 only / NULL
--                   app.norm_hijri_date(text)         → yyyy/mm/dd (year 1300–1700, month 1–12, day 1–30) / NULL
--                   app.legacy_spaces(text)           Unicode spaces (NBSP …) → ' ' (JS \s parity for the helpers above)
--                   app.fin_funding_check(source, method, payer, account, legacy) → NULL or the first broken rule
--   2. customs_ports  platform table (no org): the 7 approved legacy ports (code = UN/LOCODE, airports -AIR, unlocode, name_ar,
--                   name_en, kind sea / air / dry, daftra_value). Read-only for authenticated, nothing for anon.
--   3. party_ports  terminal operator (parties kind terminal_operator) ↔ port, per org. Staff read; transport writers
--                   add / (de)activate; no DELETE; audited.
--   4. transactions + port_code, terminal_party_id, cargo_unit_type (container / roro), chassis_no, vehicle_plate_no,
--                   transaction_type (normal / re_export), transport_mode (driver / carrier_order), transport_party_id,
--                   transport_order_no (TASTO…), transport_order_date, declaration_notes, cancelled_at / _by,
--                   cancel_reason. CHECKs: roro ⇔ chassis, plate only on roro, roro has no containers, order fields only
--                   with carrier_order, a cancelled transaction is closed. Triggers: trg_legacy_guard (API callers may
--                   not write the cancel columns), trg_legacy_norm (normalises chassis / plate / order no, checks the
--                   party kinds, the active port, the operator ↔ port mapping, the roro ↔ containers rule, and
--                   freezes a cancelled transaction). containers: trg_legacy_roro (no container on a roro transaction).
--   5. customs_declarations + declaration_date_hijri (format CHECK), declaration_type_code (import / export / clearance,
--                   a STORED generated column from declaration_type); status CHECK + accepted, cco_review_done,
--                   awaiting_duty_payment, release_ready. app.decl_fields / app.decl_insert / app.decl_json /
--                   public.correct_declaration / public.set_declaration_status re-created for the Hijri date and the
--                   stages (bodies otherwise identical to 20261103000100). app.alert_causes re-created (20261103000200):
--                   the new stages can be 'stalled'; a cancelled transaction raises no alert.
--   6. clients      + port_category (airport / port / shared), match_count, last_matched_at, source.
--      client_aliases + status (approved / suggested / rejected), confidence 0–100, occurrences, last_used_at,
--                   source_ref, approved_by / approved_at. public.match_client re-created: only an approved alias is an
--                   'alias' match, a suggested one only adds to the similarity, a rejected one is never used (body
--                   otherwise identical to 20261103000100). API inserts: source = 'manual'.
--   7. finance      supplier_payments.method / charge_collections.method CHECK + the 4 Saudi method codes.
--   8. org_service_items  per-org service catalog (the 26 legacy items, text codes, name_ar / name_en, fin_service,
--                   legacy_code). app.service_items_template(), app.seed_org_service_items(org); every existing org is
--                   seeded here and every new org by trg_seed_service_items. Staff read; accounts_manager / admin edit;
--                   no DELETE (deactivate).
--   9. public.cancel_transaction(p_tx, p_reason) — void-only cancel (operational_status closed + cancelled_*), audited
--                   through the transaction trail; cancels the active declarations; refusals listed at the function.
--                   app.g3_lock_tx re-created: no RPC writes to a cancelled transaction (no billing, no Daftra push).
--                   app.decl_no_check re-created: a number cancelled with its transaction is free again.
--                   public.dash_management / app.rpt_tx_json re-created (20261106000100): a cancel is not counted as
--                   closed ('cancelled' count apart), rows carry cancelled_at.
--  10. column grants (fail closed, re-run), staff_internal_fields (+ the hidden transaction columns), conversion lists
--                   (+ party_ports deleted, org_service_items kept)
--  11. privileges
-- Errors: existing codes only (MRS_INVALID <field>, MRS_BAD_TRANSITION <why>, MRS_NOTE_REQUIRED, …).
-- Re-runnable (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD / CREATE OR REPLACE / ON CONFLICT). Re-pasting
-- 20261103000100 (G3 registry) after this file narrows the declaration status list / drops the Hijri date from the
-- declaration RPCs, lets rejected / suggested aliases match again and re-opens cancelled transactions to the RPCs (g3_lock_tx):
-- re-paste this file right after; the same for 20261103000200 (alert_causes) and 20261106000100 (dash_management,
-- rpt_tx_json). Re-pasting 20261115000100 or
-- 20261116000100 drops party_ports / org_service_items from the conversion lists (the conversion then refuses:
-- unclassified_tables): re-paste this file right after. Re-pasting 20261104000100 (G4) narrows the payment methods
-- (refused while a sadad / mada / wallet payment exists).
-- Down-path (staging only): DROP FUNCTION public.cancel_transaction(uuid, text) and the app.* functions of §1 / §8;
-- DROP TABLE public.org_service_items, public.party_ports, public.customs_ports; ALTER TABLE … DROP COLUMN for §4–§6;
-- re-paste 20261103000100 §1–§4, 20261103000200 (alert_causes), 20261104000100 §0, 20261106000100 (dash_management,
-- rpt_tx_json) and 20261116000100 §6.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261116000100') THEN
    RAISE EXCEPTION 'LEGACY preflight: apply doc_match first (schema_versions lacks 20261116000100 doc_match)';
  END IF;
  IF to_regclass('public.document_matches') IS NULL THEN
    RAISE EXCEPTION 'LEGACY preflight: public.document_matches missing (apply 20261116000100 doc_match)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261117000100', 'legacy_core')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('transaction_type','normal',1,'عادية','Normal',true),
  ('transaction_type','re_export',2,'إعادة تصدير','Re-export',true),
  ('cargo_unit_type','container',1,'حاوية','Container',true),
  ('cargo_unit_type','roro',2,'مركبة Ro-Ro','Ro-Ro vehicle',true),
  ('transport_mode','driver',1,'سائق (موعد ونقلة)','Driver (appointment and trip)',false),
  ('transport_mode','carrier_order',2,'أمر نقل لشركة نقل','Carrier transport order',false),
  ('customs_port_kind','sea',1,'ميناء بحري','Sea port',true),
  ('customs_port_kind','air',2,'مطار','Airport',true),
  ('customs_port_kind','dry',3,'ميناء جاف','Dry port',true),
  ('declaration_type','import',1,'استيراد','Import',true),
  ('declaration_type','export',2,'تصدير','Export',true),
  ('declaration_type','clearance',3,'تصفية','Clearance',true),
  -- codes of 20261103000100 kept; the Fasah stages slot in between (sort only changes order, never a stored value)
  ('declaration_status','draft',1,'مسودة','Draft',true),
  ('declaration_status','submitted',2,'مقدَّم','Submitted',true),
  ('declaration_status','accepted',3,'قبول البيان — مرحلة تفتيش ومعاينة البضاعة','Accepted — inspection stage',true),
  ('declaration_status','under_inspection',4,'تحت المعاينة','Under inspection',true),
  ('declaration_status','cco_review_done',5,'انتهاء مراجعة مركز العمليات الجمركية','Customs operations centre review done',true),
  ('declaration_status','awaiting_duty_payment',6,'مرحلة انتظار تحصيل الرسوم الجمركية','Awaiting customs duty payment',true),
  ('declaration_status','release_ready',7,'جاهز لطباعة إشعار الفسح الإلكتروني','Ready to print the release notice',true),
  ('declaration_status','released',8,'فسح كلي','Fully released',true),
  ('declaration_status','cancelled',9,'ملغى','Cancelled',true),
  ('declaration_status','replaced',10,'مستبدل ببيان آخر','Replaced',true),
  ('client_port_category','airport',1,'مطار','Airport',false),
  ('client_port_category','port',2,'ميناء','Port',false),
  ('client_port_category','shared',3,'مشترك','Shared',false),
  ('client_source','manual',1,'إدخال يدوي','Manual',false),
  ('client_source','import',2,'رفع جماعي','Bulk import',false),
  ('client_source','daftra',3,'من دفترة','From Daftra',false),
  ('client_source','portal',4,'من بوابة العميل','From the client portal',false),
  ('client_source','legacy',5,'من النظام السابق','From the legacy system',false),
  ('alias_status','approved',1,'معتمد','Approved',false),
  ('alias_status','suggested',2,'مقترح بانتظار المراجعة','Suggested',false),
  ('alias_status','rejected',3,'مرفوض (لا يُستخدم)','Rejected (never used)',false),
  ('fin_payment_method','sadad',7,'رقم سداد','SADAD number',false),
  ('fin_payment_method','mada',8,'مدى','mada',false),
  ('fin_payment_method','fasah_wallet',9,'محفظة فسح','Fasah wallet',false),
  ('fin_payment_method','dry_port_wallet',10,'محفظة الميناء الجاف','Dry port wallet',false),
  ('fin_funding_source','org_account',1,'حساب المؤسسة','Organization account',false),
  ('fin_funding_source','cash_box',2,'الصندوق / النقدية','Cash box',false),
  ('fin_funding_source','fasah_wallet',3,'محفظة فسح','Fasah wallet',false),
  ('fin_funding_source','dry_port_wallet_org',4,'محفظة الميناء الجاف — تمويل المؤسسة','Dry port wallet — organization funded',false),
  ('fin_funding_source','client_custody',5,'عهدة العميل','Client custody',false),
  ('fin_funding_source','client_custody_dry_port',6,'عهدة العميل — محفظة الميناء الجاف','Client custody — dry port wallet',false),
  ('fin_funding_source','personal_account',7,'حساب شخصي — مستحق الاسترداد','Personal account — to be reimbursed',false),
  ('fin_funding_source','client_direct',8,'دفع العميل مباشرة','Client paid directly',false),
  ('fin_funding_source','not_applicable_receipt',9,'غير منطبق — استلام من العميل','Not applicable — received from the client',false),
  ('fin_funding_source','legacy_unknown',10,'غير محدد — سجل سابق','Unspecified — legacy record',false),
  ('fin_service','gate_in_appointment',15,'موعد دخول','Gate-in appointment',false),
  ('fin_service','gate_out_appointment',16,'موعد خروج','Gate-out appointment',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. helpers (pure)
-- ---------------------------------------------------------------------
-- JS \s also matches the Unicode spaces (NBSP, the U+2000 range, narrow NBSP, ideographic space, BOM, …) that Postgres
-- [[:space:]] does not: map them to a plain space first, so the SQL helpers below see what MarsaNorm / the legacy see
-- (Fasah / PDF / OCR / Excel text often carries NBSP).
CREATE OR REPLACE FUNCTION app.legacy_spaces(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT regexp_replace(p, '[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]', ' ', 'g')
$$;

-- legacy normalizeSearch_ (= MarsaNorm.searchKey, assets/js/legacy-norm.js): lower case, أإآ→ا ة→ه ى→ي, and no
-- whitespace (any Unicode space) / - _ / \ . (so 'Ro-Ro' = 'roro', 'تم الفسح' = 'تمالفسح'). Like the legacy, digits are NOT
-- converted (Arabic-Indic stay as typed) and diacritics are NOT removed.
CREATE OR REPLACE FUNCTION app.legacy_search_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(regexp_replace(translate(lower(app.legacy_spaces(coalesce(p, ''))), 'أإآةى', 'اااهي'), '[[:space:]_/\\.-]+', '', 'g'), '')
$$;

-- declaration status (legacy normalizeDeclarationStatus_; = MarsaNorm.normDeclarationStatus) → code, NULL when unknown
CREATE OR REPLACE FUNCTION app.norm_declaration_status(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_code text := lower(regexp_replace(app.legacy_spaces(coalesce(p, '')), '^[[:space:]]+|[[:space:]]+$', '', 'g'));
  k text := app.legacy_search_key(p);
  r record;
BEGIN
  IF k IS NULL THEN RETURN NULL; END IF;
  IF v_code = ANY (ARRAY['draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',
                         'release_ready','released','cancelled','replaced']) THEN
    RETURN v_code;
  END IF;
  -- legacy order (first hit wins), patterns already folded like legacy_search_key
  FOR r IN SELECT * FROM (VALUES
      (1, 'accepted', ARRAY['قبولالبيان','تفتيشومعاينه','مرحلهتفتيشومعاينهالبضاعه']),
      (2, 'cco_review_done', ARRAY['انتهاءمراجعهمركزالعملياتالجمركيه','انتهتمراجعهمركزالعملياتالجمركيه']),
      (3, 'awaiting_duty_payment', ARRAY['انتظارتحصيلالرسومالجمركيه','بانتظارالسداد','انتظارالسداد','الرسومالجمركيهغيرمسدده']),
      (4, 'release_ready', ARRAY['جاهزلطباعهاشعارالفسحالالكتروني','طباعهاشعارالفسح']),
      (5, 'released', ARRAY['فسحكلي','تمالفسح','مفسوح','تمالفسحكليا'])) AS x(o, code, pats) ORDER BY o
  LOOP
    IF EXISTS (SELECT 1 FROM unnest(r.pats) pt WHERE position(pt IN k) > 0) THEN RETURN r.code; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- declaration type (legacy normalizeDeclarationType_) → import / export / clearance, NULL when unknown
CREATE OR REPLACE FUNCTION app.norm_declaration_type(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN k IS NULL THEN NULL
    WHEN position('استيراد' IN k) > 0 OR k = 'import' THEN 'import'
    WHEN position('تصدير' IN k) > 0 OR position('تصدر' IN k) > 0 OR k = 'export' THEN 'export'
    WHEN position('تصفيه' IN k) > 0 OR k = 'clearance' THEN 'clearance'
  END
  FROM (SELECT app.legacy_search_key(p) AS k) x
$$;

-- TAS appointment number (legacy normalizeFasahAppointmentNoR12_): western digits, upper case, bidi marks and
-- separators removed; TAS<≥ 8 digits> or the RTL-reversed <≥ 8 digits>TAS → 'TAS' || digits; anything else NULL
CREATE OR REPLACE FUNCTION app.norm_tas(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text; d text;
BEGIN
  v := upper(app.to_western(app.legacy_spaces(coalesce(p, ''))));
  v := regexp_replace(v, '[‎‏‪-‮⁦-⁩]', '', 'g');
  v := regexp_replace(v, '[[:space:]_/\\.-]+', '', 'g');
  IF v = '' THEN RETURN NULL; END IF;
  d := substring(v FROM 'TAS([0-9]{8,})');
  IF d IS NOT NULL THEN RETURN 'TAS' || d; END IF;
  d := substring(v FROM '([0-9]{8,})TAS');
  IF d IS NOT NULL THEN RETURN 'TAS' || d; END IF;
  RETURN NULL;
END $$;

-- Saudi phone (= MarsaNorm.normSaPhone): western digits, only 0-9 and '+' kept; +966 / 00966 / 966 prefixes → 0;
-- 5XXXXXXXX → 05XXXXXXXX. Result 05XXXXXXXX (or 01[1-7]XXXXXXX when p_allow_landline), else NULL. Same stored form as
-- clients.phone and app.norm_phone (E.164 for display: '+966' || substr(x, 2)).
CREATE OR REPLACE FUNCTION app.norm_sa_phone(p text, p_allow_landline boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := regexp_replace(app.to_western(coalesce(p, '')), '[^0-9+]', '', 'g');
BEGIN
  IF v = '' THEN RETURN NULL; END IF;
  IF v LIKE '+966%' THEN v := '0' || substr(v, 5);
  ELSIF v LIKE '00966%' THEN v := '0' || substr(v, 6);
  ELSIF v LIKE '966%' AND char_length(v) IN (11, 12) THEN v := '0' || substr(v, 4);
  END IF;
  IF v ~ '^5[0-9]{8}$' THEN v := '0' || v; END IF;
  IF v ~ '^05[0-9]{8}$' THEN RETURN v; END IF;
  IF coalesce(p_allow_landline, false) AND v ~ '^01[1-7][0-9]{7}$' THEN RETURN v; END IF;
  RETURN NULL;
END $$;

-- chassis / VIN (legacy normalizeChassisNo_): upper case, western digits, A-Z0-9 only; NULL when nothing is left
CREATE OR REPLACE FUNCTION app.norm_chassis(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(regexp_replace(upper(app.to_western(coalesce(p, ''))), '[^A-Z0-9]', '', 'g'), '')
$$;

-- Hijri date (legacy normalizeHijriDate_, numeric text): Arabic / Persian digits, '.' / '-' / '/' separators,
-- a trailing هـ / ه / AH marker, yyyy/m/d or d/m/yyyy → 'yyyy/mm/dd' (= MarsaNorm.normalizeHijri, numeric text); year 1300–1700, month 1–12, day 1–30; anything else NULL
CREATE OR REPLACE FUNCTION app.norm_hijri_date(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text; a text[]; y text; m text; d text;
BEGIN
  v := regexp_replace(app.to_western(app.legacy_spaces(coalesce(p, ''))), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v := regexp_replace(v, '[[:space:]]*(هـ|ه|ھ|AH|A\.H\.?)[[:space:]]*\.?$', '', 'i');
  v := regexp_replace(translate(v, '.-', '//'), '[[:space:]]+', '', 'g');
  IF v = '' THEN RETURN NULL; END IF;
  a := string_to_array(v, '/');
  IF cardinality(a) <> 3 THEN RETURN NULL; END IF;
  IF char_length(a[3]) = 4 THEN d := a[1]; m := a[2]; y := a[3]; ELSE y := a[1]; m := a[2]; d := a[3]; END IF;
  IF y !~ '^[0-9]{4}$' OR m !~ '^[0-9]{1,2}$' OR d !~ '^[0-9]{1,2}$' THEN RETURN NULL; END IF;
  IF y::int NOT BETWEEN 1300 AND 1700 OR m::int NOT BETWEEN 1 AND 12 OR d::int NOT BETWEEN 1 AND 30 THEN RETURN NULL; END IF;
  RETURN y || '/' || lpad(m::int::text, 2, '0') || '/' || lpad(d::int::text, 2, '0');
END $$;

-- funding source ↔ payment method matrix (legacy normalizePaymentFundingSource_ + validatePaymentFundingMethodCombination_).
-- NULL = consistent, else the first broken rule: payment_method / funding_source (unknown code), fasah_wallet_source,
-- fasah_wallet_method, cash_box_method, dry_port_wallet_source, dry_port_wallet_method, payer_name, paying_account,
-- wallet_no_account. p_legacy = the legacy isLegacyEdit (importing / editing a legacy record, step 9): only then are the
-- funding source 'legacy_unknown' (or none) and the method 'legacy_unknown' (or none) — legacy «غير محدد — سجل سابق» —
-- accepted, and only then may a sadad / mada / bank transfer row lack its paying account. A new record never gets them.
-- ('legacy_unknown' is not a fin_payment_method code on purpose: the payment RPCs check app.is_code and refuse it.)
CREATE OR REPLACE FUNCTION app.fin_funding_check(p_source text, p_method text, p_payer text, p_account text,
                                                 p_legacy boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_payer text := nullif(btrim(coalesce(p_payer, '')), '');
  v_acct text := nullif(btrim(coalesce(p_account, '')), '');
  v_dry text[] := ARRAY['dry_port_wallet_org','client_custody_dry_port'];
  v_legacy boolean := coalesce(p_legacy, false);
BEGIN
  IF v_legacy AND (p_method IS NULL OR p_method = 'legacy_unknown') THEN
    p_method := 'legacy_unknown';
  ELSIF p_method IS NULL OR NOT EXISTS (SELECT 1 FROM public.status_labels s WHERE s.domain = 'fin_payment_method' AND s.code = p_method) THEN
    RETURN 'payment_method';
  END IF;
  IF v_legacy AND (p_source IS NULL OR p_source = 'legacy_unknown') THEN
    p_source := 'legacy_unknown';
  ELSIF p_source IS NULL OR p_source = 'legacy_unknown'
        OR NOT EXISTS (SELECT 1 FROM public.status_labels s WHERE s.domain = 'fin_funding_source' AND s.code = p_source) THEN
    RETURN 'funding_source';
  END IF;
  IF p_method = 'fasah_wallet' AND p_source <> 'fasah_wallet' THEN RETURN 'fasah_wallet_source'; END IF;
  IF p_source = 'fasah_wallet' AND p_method <> 'fasah_wallet' THEN RETURN 'fasah_wallet_method'; END IF;
  IF p_source = 'cash_box' AND p_method <> 'cash' THEN RETURN 'cash_box_method'; END IF;
  IF p_method = 'dry_port_wallet' AND NOT (p_source = ANY (v_dry)) THEN RETURN 'dry_port_wallet_source'; END IF;
  IF p_source = ANY (v_dry) AND p_method <> 'dry_port_wallet' THEN RETURN 'dry_port_wallet_method'; END IF;
  IF p_source = 'personal_account' AND v_payer IS NULL THEN RETURN 'payer_name'; END IF;
  IF p_method IN ('sadad','mada','bank_transfer') AND v_acct IS NULL AND NOT v_legacy THEN RETURN 'paying_account'; END IF;
  IF p_method IN ('fasah_wallet','dry_port_wallet') AND v_acct IS NOT NULL THEN RETURN 'wallet_no_account'; END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 2. customs_ports (platform reference data, no org)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customs_ports (
  code         text PRIMARY KEY CHECK (code ~ '^[A-Z]{5}(-AIR)?$'),
  unlocode     text NOT NULL CHECK (unlocode ~ '^[A-Z]{5}$'),
  kind         text NOT NULL CHECK (kind IN ('sea','air','dry')),
  name_ar      text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 120),
  name_en      text NOT NULL CHECK (char_length(name_en) BETWEEN 2 AND 120),
  daftra_value text CHECK (char_length(daftra_value) BETWEEN 2 AND 120),
  sort         int  NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customs_ports_kind_code_chk CHECK (split_part(code, '-', 1) = unlocode AND (kind = 'air') = (code LIKE '%-AIR')),
  CONSTRAINT customs_ports_name_uniq UNIQUE (name_ar)
);
COMMENT ON TABLE public.customs_ports IS 'Approved KSA customs ports (legacy APPROVED_CUSTOMS_PORTS_R11). Platform reference data: read-only for staff and clients, written by migrations only. code = UN/LOCODE of the location; an airport shares its city LOCODE and carries the suffix -AIR (SAJED = Jeddah Islamic Port, SAJED-AIR = King Abdulaziz airport), the codes of MarsaNorm.PORTS. daftra_value = the value of the Daftra invoice custom field «ميناء القدوم» (NULL: the legacy had none, the Arabic name is sent).';

-- the 7 approved legacy ports; daftra_value = legacy mapPortToDaftraCustomField_ (Rabigh has no Daftra mapping in the
-- legacy code: NULL, its name is sent as-is). Riyadh dry port: the value the legacy list intends ('جمرك الرياض - الميناء
-- الجاف'); the legacy code never reached it (its term 'الميناء الجاف' is not in the folded name 'ميناءالرياضالجاف', so it
-- sent the raw name 'ميناء الرياض الجاف'). Confirm against the Daftra (KSA) custom-field list before step 7 uses it.
INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value, sort) VALUES
  ('SAJED','SAJED','sea','ميناء جدة الإسلامي','Jeddah Islamic Port','جمرك ميناء جدة الإسلامي',1),
  ('SADMM','SADMM','sea','ميناء الملك عبدالعزيز بالدمام','King Abdulaziz Port, Dammam','جمرك ميناء الملك عبدالعزيز',2),
  ('SAKAC','SAKAC','sea','ميناء الملك عبدالله (رابغ)','King Abdullah Port, Rabigh',NULL,3),
  ('SARUH','SARUH','dry','ميناء الرياض الجاف','Riyadh Dry Port','جمرك الرياض - الميناء الجاف',4),
  ('SAJED-AIR','SAJED','air','مطار الملك عبدالعزيز الدولي بجدة','King Abdulaziz International Airport, Jeddah','جمرك مطار الملك عبدالعزيز الدولي',5),
  ('SADMM-AIR','SADMM','air','مطار الملك فهد الدولي بالدمام','King Fahd International Airport, Dammam','جمرك مطار الملك فهد الدولي',6),
  ('SARUH-AIR','SARUH','air','مطار الملك خالد الدولي بالرياض','King Khalid International Airport, Riyadh','جمرك مطار الملك خالد الدولي',7)
ON CONFLICT (code) DO UPDATE
  SET unlocode = EXCLUDED.unlocode, kind = EXCLUDED.kind, name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en,
      daftra_value = EXCLUDED.daftra_value, sort = EXCLUDED.sort;

-- ---------------------------------------------------------------------
-- 3. party_ports (terminal operator ↔ port, per org)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.party_ports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  party_id   uuid NOT NULL,
  port_code  text NOT NULL REFERENCES public.customs_ports(code),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_ports_party_fk FOREIGN KEY (party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT party_ports_uniq UNIQUE (party_id, port_code)
);
COMMENT ON TABLE public.party_ports IS 'Which terminal operator works at which approved port (legacy: choosing a port filters the operator list). Staff read; transport writers add and (de)activate; never deleted.';
CREATE INDEX IF NOT EXISTS party_ports_org_port_idx ON public.party_ports (org_id, port_code);

-- the party is a terminal operator of the same org; the port is active (definer: sees the parent rows)
CREATE OR REPLACE FUNCTION app.tg_party_ports_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.parties p WHERE p.id = NEW.party_id AND p.org_id = NEW.org_id
                    AND 'terminal_operator' = ANY (p.kinds)) THEN
    PERFORM app.fail('MRS_INVALID', 'party_id');
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.customs_ports c WHERE c.code = NEW.port_code AND c.is_active) THEN
    PERFORM app.fail('MRS_INVALID', 'port_code');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.party_ports;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.party_ports FOR EACH ROW EXECUTE FUNCTION app.tg_party_ports_before();
DROP TRIGGER IF EXISTS trg_guard ON public.party_ports;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.party_ports FOR EACH ROW
  EXECUTE FUNCTION app.tg_guard_generic('id','org_id','party_id','port_code','created_by','created_at');
DROP TRIGGER IF EXISTS trg_stamp ON public.party_ports;
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.party_ports FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();
DROP TRIGGER IF EXISTS trg_touch ON public.party_ports;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.party_ports FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_audit ON public.party_ports;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.party_ports FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

-- ---------------------------------------------------------------------
-- 4. transactions: legacy columns
-- ---------------------------------------------------------------------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS port_code text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS terminal_party_id uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS cargo_unit_type text NOT NULL DEFAULT 'container';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS chassis_no text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS vehicle_plate_no text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS transaction_type text NOT NULL DEFAULT 'normal';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS transport_mode text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS transport_party_id uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS transport_order_no text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS transport_order_date date;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS declaration_notes text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS cancelled_by uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_port_fk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_port_fk FOREIGN KEY (port_code) REFERENCES public.customs_ports(code);
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_terminal_fk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_terminal_fk
  FOREIGN KEY (terminal_party_id, org_id) REFERENCES public.parties(id, org_id);
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_transport_party_fk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_transport_party_fk
  FOREIGN KEY (transport_party_id, org_id) REFERENCES public.parties(id, org_id);
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_cargo_unit_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_cargo_unit_chk CHECK (cargo_unit_type IN ('container','roro'));
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_chassis_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_chassis_chk CHECK (chassis_no ~ '^[A-Z0-9]{4,30}$');
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_plate_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_plate_chk
  CHECK (char_length(vehicle_plate_no) BETWEEN 2 AND 20 AND vehicle_plate_no !~ '[[:space:]]');
-- Ro-Ro ⇔ a chassis number; a plate only on Ro-Ro; a Ro-Ro transaction counts no containers
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_roro_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_roro_chk CHECK (
  ((cargo_unit_type = 'roro') = (chassis_no IS NOT NULL))
  AND (vehicle_plate_no IS NULL OR cargo_unit_type = 'roro')
  AND (cargo_unit_type <> 'roro' OR container_count = 0));
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_chk CHECK (transaction_type IN ('normal','re_export'));
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_transport_mode_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_transport_mode_chk CHECK (transport_mode IN ('driver','carrier_order'));
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_transport_order_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_transport_order_chk CHECK (
  (transport_order_no IS NULL OR transport_order_no ~ '^TASTO[0-9]{1,20}$')
  AND (transport_mode IS NOT DISTINCT FROM 'carrier_order' OR (transport_order_no IS NULL AND transport_order_date IS NULL)));
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_declaration_notes_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_declaration_notes_chk CHECK (char_length(declaration_notes) <= 2000);
-- void-only cancel: a reason with the time, and a cancelled transaction is closed
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_cancel_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_cancel_chk CHECK (
  ((cancelled_at IS NULL) = (cancel_reason IS NULL)) AND char_length(cancel_reason) <= 500
  AND (cancelled_at IS NULL OR operational_status = 'closed'));
-- a TASTO order number belongs to one live transaction of the org
CREATE UNIQUE INDEX IF NOT EXISTS transactions_transport_order_uidx ON public.transactions (org_id, transport_order_no)
  WHERE transport_order_no IS NOT NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_port_idx ON public.transactions (org_id, port_code) WHERE port_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_chassis_idx ON public.transactions (org_id, chassis_no) WHERE chassis_no IS NOT NULL;

-- API callers (staff through PostgREST) never write the cancel columns: public.cancel_transaction does.
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_transactions_legacy_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.cancelled_at := NULL; NEW.cancelled_by := NULL; NEW.cancel_reason := NULL;
    ELSE
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['cancelled_at','cancelled_by','cancel_reason']);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- normalisation + cross-row rules (definer: reads parties / party_ports / containers whatever the caller sees)
CREATE OR REPLACE FUNCTION app.tg_transactions_legacy_norm() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text;
BEGIN
  -- a cancelled transaction is frozen (only updated_at / status_changed_at may move)
  IF TG_OP = 'UPDATE' AND OLD.cancelled_at IS NOT NULL
     AND (to_jsonb(OLD) - ARRAY['updated_at','status_changed_at']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updated_at','status_changed_at']) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled');
  END IF;
  -- chassis: A-Z0-9 (legacy normalizeChassisNo_); something typed that leaves nothing is refused
  IF NEW.chassis_no IS NOT NULL THEN
    v := app.norm_chassis(NEW.chassis_no);
    IF v IS NULL AND btrim(NEW.chassis_no) <> '' THEN PERFORM app.fail('MRS_INVALID', 'chassis_no'); END IF;
    NEW.chassis_no := v;
  END IF;
  -- plate: one spelling like trucks.plate_no ('ABC 1234' / 'abc-1234' / Arabic-Indic digits)
  IF NEW.vehicle_plate_no IS NOT NULL THEN
    NEW.vehicle_plate_no := app.norm_code(replace(translate(NEW.vehicle_plate_no, 'أإآ', 'ااا'), '-', ''));
  END IF;
  -- TASTO order number: upper case, western digits, no spaces
  IF NEW.transport_order_no IS NOT NULL THEN NEW.transport_order_no := app.norm_code(NEW.transport_order_no); END IF;
  NEW.declaration_notes := nullif(btrim(coalesce(NEW.declaration_notes, '')), '');
  -- the port: an active approved port (only checked when it changes: a port retired later stays on old rows)
  IF NEW.port_code IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.port_code IS DISTINCT FROM OLD.port_code)
     AND NOT EXISTS (SELECT 1 FROM public.customs_ports c WHERE c.code = NEW.port_code AND c.is_active) THEN
    PERFORM app.fail('MRS_INVALID', 'port_code');
  END IF;
  -- the terminal operator: kind terminal_operator; when the operator is mapped to ports, the transaction's port is one
  IF NEW.terminal_party_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.terminal_party_id IS DISTINCT FROM OLD.terminal_party_id
                                             OR NEW.port_code IS DISTINCT FROM OLD.port_code) THEN
    IF NOT EXISTS (SELECT 1 FROM public.parties p WHERE p.id = NEW.terminal_party_id AND p.org_id = NEW.org_id
                      AND 'terminal_operator' = ANY (p.kinds)) THEN
      PERFORM app.fail('MRS_INVALID', 'terminal_party_id');
    END IF;
    IF NEW.port_code IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.party_ports pp WHERE pp.party_id = NEW.terminal_party_id AND pp.is_active)
       AND NOT EXISTS (SELECT 1 FROM public.party_ports pp WHERE pp.party_id = NEW.terminal_party_id AND pp.is_active
                          AND pp.port_code = NEW.port_code) THEN
      PERFORM app.fail('MRS_INVALID', 'terminal_party_id');
    END IF;
  END IF;
  -- the transport company: kind carrier
  IF NEW.transport_party_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.transport_party_id IS DISTINCT FROM OLD.transport_party_id)
     AND NOT EXISTS (SELECT 1 FROM public.parties p WHERE p.id = NEW.transport_party_id AND p.org_id = NEW.org_id
                        AND 'carrier' = ANY (p.kinds)) THEN
    PERFORM app.fail('MRS_INVALID', 'transport_party_id');
  END IF;
  -- Ro-Ro carries a vehicle, not containers
  IF TG_OP = 'UPDATE' AND NEW.cargo_unit_type = 'roro' AND OLD.cargo_unit_type IS DISTINCT FROM 'roro'
     AND EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = NEW.id) THEN
    PERFORM app.fail('MRS_INVALID', 'cargo_unit_type');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_legacy_guard ON public.transactions;
CREATE TRIGGER trg_legacy_guard BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_legacy_guard();
DROP TRIGGER IF EXISTS trg_legacy_norm ON public.transactions;
CREATE TRIGGER trg_legacy_norm BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_legacy_norm();

-- containers: none on a Ro-Ro transaction
CREATE OR REPLACE FUNCTION app.tg_containers_legacy_roro() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = NEW.transaction_id AND t.cargo_unit_type = 'roro') THEN
    PERFORM app.fail('MRS_INVALID', 'cargo_unit_type');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_roro ON public.containers;
CREATE TRIGGER trg_legacy_roro BEFORE INSERT ON public.containers
  FOR EACH ROW EXECUTE FUNCTION app.tg_containers_legacy_roro();

-- ---------------------------------------------------------------------
-- 5. customs_declarations: Hijri date, declaration type code, Fasah stages
-- ---------------------------------------------------------------------
ALTER TABLE public.customs_declarations ADD COLUMN IF NOT EXISTS declaration_date_hijri text;
-- the type code is a STORED generated column: existing rows get it without an UPDATE (no trigger runs, updated_at and the
-- declaration_stalled alert clock are untouched, no audit rows) and nobody can write it
ALTER TABLE public.customs_declarations ADD COLUMN IF NOT EXISTS declaration_type_code text
  GENERATED ALWAYS AS (app.norm_declaration_type(declaration_type)) STORED;
ALTER TABLE public.customs_declarations DROP CONSTRAINT IF EXISTS customs_declarations_hijri_chk;
ALTER TABLE public.customs_declarations ADD CONSTRAINT customs_declarations_hijri_chk
  CHECK (declaration_date_hijri ~ '^(1[3-6][0-9]{2}|1700)/(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|30)$');
ALTER TABLE public.customs_declarations DROP CONSTRAINT IF EXISTS customs_declarations_type_code_chk;
ALTER TABLE public.customs_declarations ADD CONSTRAINT customs_declarations_type_code_chk
  CHECK (declaration_type_code IN ('import','export','clearance'));
-- the inline status CHECK of 20261103000100 (default name), re-created as a superset
ALTER TABLE public.customs_declarations DROP CONSTRAINT IF EXISTS customs_declarations_status_check;
ALTER TABLE public.customs_declarations ADD CONSTRAINT customs_declarations_status_check CHECK (status IN
  ('draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment','release_ready','released',
   'cancelled','replaced'));

CREATE OR REPLACE FUNCTION app.tg_declarations_legacy_norm() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.declaration_date_hijri IS NOT NULL THEN
    IF btrim(NEW.declaration_date_hijri) = '' THEN NEW.declaration_date_hijri := NULL;
    ELSE
      NEW.declaration_date_hijri := app.norm_hijri_date(NEW.declaration_date_hijri);
      IF NEW.declaration_date_hijri IS NULL THEN PERFORM app.fail('MRS_INVALID', 'declaration_date_hijri'); END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_norm ON public.customs_declarations;
CREATE TRIGGER trg_legacy_norm BEFORE INSERT OR UPDATE ON public.customs_declarations
  FOR EACH ROW EXECUTE FUNCTION app.tg_declarations_legacy_norm();

-- payload → normalized fields (20261103000100) + declaration_date_hijri, + the Fasah stages
CREATE OR REPLACE FUNCTION app.decl_fields(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := '{}'::jsonb; s text; h text;
BEGIN
  IF p ? 'declaration_no' THEN
    s := app.norm_code(app.ptext(p, 'declaration_no', 60, true));
    IF char_length(s) > 30 THEN PERFORM app.fail('MRS_TOO_LONG', 'declaration_no'); END IF;
    v := v || jsonb_build_object('declaration_no', s);
  END IF;
  IF p ? 'declaration_type' THEN v := v || jsonb_build_object('declaration_type', app.ptext(p, 'declaration_type', 40)); END IF;
  IF p ? 'declaration_date' THEN v := v || jsonb_build_object('declaration_date', app.pdate(p, 'declaration_date')); END IF;
  IF p ? 'declaration_date_hijri' THEN                                                                  -- LEGACY
    s := app.ptext(p, 'declaration_date_hijri', 20);
    h := app.norm_hijri_date(s);
    IF s IS NOT NULL AND h IS NULL THEN PERFORM app.fail('MRS_INVALID', 'declaration_date_hijri'); END IF;
    v := v || jsonb_build_object('declaration_date_hijri', h);
  END IF;
  IF p ? 'notes' THEN v := v || jsonb_build_object('notes', app.ptext(p, 'notes', 2000)); END IF;
  IF p ? 'source_document_id' THEN v := v || jsonb_build_object('source_document_id', app.puuid(p, 'source_document_id')); END IF;
  IF p ? 'status' THEN
    s := app.ptext(p, 'status', 30);
    IF s IS NULL OR s NOT IN ('draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',
                              'release_ready','released') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    v := v || jsonb_build_object('status', s);
  END IF;
  IF p ? 'source' THEN
    s := app.ptext(p, 'source', 20);
    IF s IS NULL OR s NOT IN ('manual','ocr','import','fasah') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
    v := v || jsonb_build_object('source', s);
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.decl_json(d public.customs_declarations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', d.id, 'org_id', d.org_id, 'transaction_id', d.transaction_id,
    'declaration_no', d.declaration_no, 'declaration_type', d.declaration_type, 'declaration_date', d.declaration_date,
    'status', d.status, 'source', d.source, 'source_document_id', d.source_document_id, 'corrected_at', d.corrected_at,
    'cancelled_at', d.cancelled_at, 'cancel_reason', d.cancel_reason, 'replaced_by_id', d.replaced_by_id,
    'notes', d.notes, 'created_by', d.created_by, 'created_at', d.created_at, 'updated_at', d.updated_at,
    'declaration_date_hijri', d.declaration_date_hijri, 'declaration_type_code', d.declaration_type_code)   -- LEGACY
$$;

-- new declaration row on p_tx from a payload (shared by add / cancel+replace); 20261103000100 + declaration_date_hijri
CREATE OR REPLACE FUNCTION app.decl_insert(p_tx public.transactions, p jsonb, p_allow_same_tx boolean)
RETURNS public.customs_declarations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_f jsonb; v_d public.customs_declarations; v_doc uuid;
BEGIN
  PERFORM app.only_keys(p, ARRAY['declaration_no','declaration_type','declaration_date','status','source',
                                 'source_document_id','notes','declaration_date_hijri']);
  v_f := app.decl_fields(p);
  IF v_f ->> 'declaration_no' IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_no'); END IF;
  v_doc := (v_f ->> 'source_document_id')::uuid;
  IF v_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.documents d
       WHERE d.id = v_doc AND d.transaction_id = p_tx.id AND d.voided_at IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', 'source_document_id');
  END IF;
  PERFORM app.decl_no_check(p_tx.org_id, p_tx.id, v_f ->> 'declaration_no', NULL, p_allow_same_tx);
  INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, declaration_type, declaration_date,
                                           status, source, source_document_id, notes, created_by, declaration_date_hijri)
  VALUES (p_tx.org_id, p_tx.id, v_f ->> 'declaration_no', v_f ->> 'declaration_type', (v_f ->> 'declaration_date')::date,
          coalesce(v_f ->> 'status', 'submitted'), coalesce(v_f ->> 'source', 'manual'), v_doc, v_f ->> 'notes', auth.uid(),
          v_f ->> 'declaration_date_hijri')
  RETURNING * INTO v_d;
  PERFORM app.decl_event(v_d, 'added', NULL, NULL, jsonb_build_object('source', v_d.source));
  RETURN v_d;
END $$;

-- set_declaration_status(p_id, draft|submitted|accepted|under_inspection|cco_review_done|awaiting_duty_payment|
-- release_ready|released, p_note) — 20261103000100 with the Fasah stages in the order.
-- Forward = any ops writer. Backward = correction: note + senior role. Cancel / replace → cancel_declaration.
CREATE OR REPLACE FUNCTION public.set_declaration_status(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.customs_declarations; v_tx public.transactions; v_from text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_order text[] := ARRAY['draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',
                          'release_ready','released'];
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

-- correct_declaration(p_id, {declaration_no?, declaration_type?, declaration_date?, declaration_date_hijri?, notes?,
-- source_document_id?}, p_reason) — 20261103000100 + declaration_date_hijri
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
  PERFORM app.only_keys(p_payload, ARRAY['declaration_no','declaration_type','declaration_date','notes','source_document_id',
                                         'declaration_date_hijri']);
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
    declaration_date_hijri = CASE WHEN v_f ? 'declaration_date_hijri' THEN v_f ->> 'declaration_date_hijri' ELSE d.declaration_date_hijri END,
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

-- alert causes (20261103000200 §, re-created): body identical except (LEGACY) a cancelled transaction raises no alert, and
-- a declaration in any active Fasah stage before released (accepted / cco_review_done / awaiting_duty_payment /
-- release_ready too) can be 'stalled' — moving a declaration into a new stage no longer drops it from the alert.
CREATE OR REPLACE FUNCTION app.alert_causes(p_org uuid, p_now timestamptz)
RETURNS TABLE (dedupe_key text, kind text, severity text, branch_id uuid, transaction_id uuid, container_id uuid,
               subject_id uuid, title_ar text, title_en text, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH today AS (SELECT (p_now AT TIME ZONE 'Asia/Riyadh')::date AS d),
  active_tx AS (
    SELECT t.* FROM public.transactions t
     WHERE t.org_id = p_org AND t.cancelled_at IS NULL                                                      -- LEGACY
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
   WHERE a.org_id = p_org AND a.status IN ('requested','confirmed') AND t.cancelled_at IS NULL            -- LEGACY
     AND a.appointment_at > p_now AND a.appointment_at <= p_now + interval '24 hours'
  UNION ALL
  -- window over without an outcome, or marked missed and not rescheduled / cancelled yet
  SELECT 'appointment_missed:' || a.id, 'appointment_missed', 'critical', t.branch_id, t.id, a.container_id, a.id,
         'موعد فائت يحتاج إعادة جدولة — ' || t.ref, 'Missed appointment needs a new slot — ' || t.ref, a.appointment_at
    FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.org_id = p_org AND t.cancelled_at IS NULL                                                      -- LEGACY
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
   WHERE c.org_id = p_org AND c.return_status IN ('pending','evidence_submitted','disputed') AND t.cancelled_at IS NULL -- LEGACY
     AND c.return_deadline IS NOT NULL AND c.return_deadline <= today.d + 3
  UNION ALL
  SELECT 'exception_open:' || e.id, 'exception_open', CASE WHEN e.kind = 'customs_rejection' THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, e.container_id, e.id,
         'استثناء مفتوح: ' || coalesce(l.label_ar, e.kind) || ' — ' || t.ref,
         'Open exception: ' || coalesce(l.label_en, e.kind) || ' — ' || t.ref, NULL::timestamptz
    FROM public.operational_exceptions e JOIN public.transactions t ON t.id = e.transaction_id
    LEFT JOIN public.status_labels l ON l.domain = 'exception_kind' AND l.code = e.kind
   WHERE e.org_id = p_org AND e.status IN ('open','in_progress') AND t.cancelled_at IS NULL              -- LEGACY
  UNION ALL
  -- an active declaration with no status change for 3 days on an open transaction
  SELECT 'declaration_stalled:' || d.id || ':' || d.status, 'declaration_stalled', 'warning', t.branch_id, t.id, NULL::uuid, d.id,
         'بيان جمركي ' || d.declaration_no || ' بلا تحديث منذ 3 أيام — ' || t.ref,
         'Declaration ' || d.declaration_no || ' not updated for 3 days — ' || t.ref, d.updated_at + interval '3 days'
    FROM public.customs_declarations d JOIN active_tx t ON t.id = d.transaction_id
   WHERE d.status IN ('draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',   -- LEGACY
                      'release_ready') AND d.updated_at < p_now - interval '3 days'
$$;

-- ---------------------------------------------------------------------
-- 6. clients + client_aliases
-- ---------------------------------------------------------------------
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS port_category text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS match_count int NOT NULL DEFAULT 0;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS last_matched_at timestamptz;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_port_category_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_port_category_chk CHECK (port_category IN ('airport','port','shared'));
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_match_count_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_match_count_chk CHECK (match_count >= 0);
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_source_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_source_chk CHECK (source IN ('manual','import','daftra','portal','legacy'));

-- match statistics and the source are written by the matching / import RPCs only (API callers: reset on insert, immutable
-- on update)
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_clients_legacy_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF TG_OP = 'INSERT' THEN
      -- provenance is set by the import / Daftra / portal / legacy RPCs only; a client typed in by staff is 'manual'
      NEW.match_count := 0; NEW.last_matched_at := NULL; NEW.source := 'manual';
    ELSE
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['match_count','last_matched_at','source']);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_guard ON public.clients;
CREATE TRIGGER trg_legacy_guard BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION app.tg_clients_legacy_guard();

ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved';
ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS confidence int;
ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS occurrences int NOT NULL DEFAULT 1;
ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE public.client_aliases ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.client_aliases DROP CONSTRAINT IF EXISTS client_aliases_status_chk;
ALTER TABLE public.client_aliases ADD CONSTRAINT client_aliases_status_chk CHECK (status IN ('approved','suggested','rejected'));
ALTER TABLE public.client_aliases DROP CONSTRAINT IF EXISTS client_aliases_confidence_chk;
ALTER TABLE public.client_aliases ADD CONSTRAINT client_aliases_confidence_chk CHECK (confidence BETWEEN 0 AND 100);
ALTER TABLE public.client_aliases DROP CONSTRAINT IF EXISTS client_aliases_occurrences_chk;
ALTER TABLE public.client_aliases ADD CONSTRAINT client_aliases_occurrences_chk CHECK (occurrences >= 1);
ALTER TABLE public.client_aliases DROP CONSTRAINT IF EXISTS client_aliases_source_ref_chk;
ALTER TABLE public.client_aliases ADD CONSTRAINT client_aliases_source_ref_chk CHECK (char_length(source_ref) <= 120);
CREATE INDEX IF NOT EXISTS client_aliases_status_idx ON public.client_aliases (org_id, status);

-- API inserts: the approver is the caller (approved rows only), counters start fresh.
-- SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_client_aliases_legacy() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    NEW.occurrences := 1; NEW.last_used_at := NULL;
    NEW.approved_by := CASE WHEN NEW.status = 'approved' THEN auth.uid() END;
    NEW.approved_at := CASE WHEN NEW.status = 'approved' THEN now() END;
  ELSIF NEW.status = 'approved' AND NEW.approved_at IS NULL THEN
    NEW.approved_at := now();
  END IF;
  NEW.source_ref := nullif(btrim(coalesce(NEW.source_ref, '')), '');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_legacy ON public.client_aliases;
CREATE TRIGGER trg_legacy BEFORE INSERT ON public.client_aliases
  FOR EACH ROW EXECUTE FUNCTION app.tg_client_aliases_legacy();

-- match_client(p_org, {name, name_en?, vat_number, cr_number}) — 20261103000100; a rejected alias is never used, and only
-- a staff-approved alias is an 'alias' match (legacy findCustomerByAlias_ used 'معتمد من الموظف' only): a 'suggested' alias
-- (AI / OCR, waiting for review) only feeds the similarity score, so it can at most give a 'weak' candidate.
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
           EXISTS (SELECT 1 FROM public.client_aliases a WHERE a.client_id = c.id AND a.status = 'approved'      -- LEGACY
                      AND (a.alias_norm = v_name OR a.alias_norm = v_name_en)) AS alias_hit,
           coalesce(app.norm_name(c.name_ar) IN (v_name, v_name_en), false)
             OR coalesce(app.norm_name(c.name_en) IN (v_name, v_name_en), false) AS name_hit,
           greatest(app.name_sim(v_name, app.norm_name(c.name_ar)), app.name_sim(v_name, app.norm_name(c.name_en)),
                    app.name_sim(v_name_en, app.norm_name(c.name_ar)), app.name_sim(v_name_en, app.norm_name(c.name_en)),
                    (SELECT max(greatest(app.name_sim(v_name, a.alias_norm), app.name_sim(v_name_en, a.alias_norm)))
                       FROM public.client_aliases a WHERE a.client_id = c.id AND a.status <> 'rejected')) AS sim   -- LEGACY
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
-- 7. finance: the Saudi payment methods (fin_payment_method above; the RPCs check app.is_code)
-- ---------------------------------------------------------------------
ALTER TABLE public.supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_method_check;
ALTER TABLE public.supplier_payments ADD CONSTRAINT supplier_payments_method_check CHECK (method IN
  ('bank_transfer','cash','cheque','card','offset','other','sadad','mada','fasah_wallet','dry_port_wallet'));
ALTER TABLE public.charge_collections DROP CONSTRAINT IF EXISTS charge_collections_method_check;
ALTER TABLE public.charge_collections ADD CONSTRAINT charge_collections_method_check CHECK (method IN
  ('bank_transfer','cash','cheque','card','offset','other','sadad','mada','fasah_wallet','dry_port_wallet'));

-- ---------------------------------------------------------------------
-- 8. per-org service catalog (the 26 legacy service items)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_service_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  code        text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ar     text NOT NULL CHECK (char_length(name_ar) BETWEEN 2 AND 160),
  name_en     text CHECK (char_length(name_en) <= 160),
  fin_service text,
  legacy_code text CHECK (legacy_code ~ '^[0-9]{1,10}$'),
  sort        int NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 10000),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('template','manual')),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_service_items_code_uniq UNIQUE (org_id, code),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.org_service_items IS 'Per-org service / fee catalog (legacy Payments defaultServiceItems, 26 items). code = stable text code; fin_service = the G4 fin_service code it maps to; legacy_code = the product code of the legacy account (for importing legacy payments; the Daftra product link is daftra_item_links). Seeded for every org; never deleted (deactivate).';

-- the template: [sort, code, name_ar, name_en, fin_service, legacy_code]
CREATE OR REPLACE FUNCTION app.service_items_template() RETURNS TABLE (sort int, code text, name_ar text, name_en text,
                                                                       fin_service text, legacy_code text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT * FROM (VALUES
    (1,  'do_late_linking_fee',    'غرامة تأخير ربط إذن التسليم', 'DO Late Linking Fee',              'delivery_order',       '000192'),
    (2,  'transportation_cost',    'تكلفة النقل',                 'Transportation Cost',              'transport',            '000191'),
    (3,  'inbound_freight',        'أجور شحن وارد',               'Inbound Freight Charges',          'other',                '000190'),
    (4,  'gate_in_appointment',    'موعد دخول',                   'Gate-in Appointment',              'gate_in_appointment',  '000189'),
    (5,  'gate_out_appointment',   'موعد خروج',                   'Gate-out Appointment',             'gate_out_appointment', '000186'),
    (6,  'agent_fines_merge',      'غرامات وكيل ملاحي (دمج)',      'Shipping Agent Fines (Merge)',     'other',                '000184'),
    (7,  'agent_fines_extension',  'غرامات وكيل ملاحي (تمديد)',    'Shipping Agent Fines (Extension)', 'other',                '000183'),
    (8,  'logistics_services',     'خدمات لوجستية',               'Logistics Services',               'other',                '000181'),
    (9,  'port_entry_permit',      'تصريح دخول الميناء',          'Port Entry Permit',                'port_charges',         '000179'),
    (10, 'storage_charges',        'أجور تخزين',                  'Storage Charges',                  'storage',              '000177'),
    (11, 'bl_endorsement',         'تجيير بوليصة',                'Bill of Lading (B/L) Endorsement', 'documentation',        '000176'),
    (12, 'sending_documents',      'إرسال أوراق',                 'Sending Documents',                'documentation',        '000175'),
    (13, 'port_charges',           'أجور الموانئ',                'Port Charges',                     'port_charges',         '000174'),
    (14, 'saber_certificate',      'أجور شهادة سابر',             'SABER Certificate Fees',           'saber',                '000173'),
    (15, 'outbound_freight',       'أجور شحن صادر',               'Outbound Freight Charges',         'other',                '000171'),
    (16, 'transport_charges',      'أجور النقل',                  'Transport Charges',                'transport',            '000170'),
    (17, 'other_charges',          'أجور أخرى',                   'Other Charges',                    'other',                '000169'),
    (18, 'port_storage_groundage', 'سداد أرضيات',                 'Port Storage (Groundage) Payment', 'storage',              '000163'),
    (19, 'handling_charges',       'أجور مناولة',                 'Handling Charges',                 'port_charges',         '000162'),
    (20, 'delivery_order',         'إذن تسليم',                   'Delivery Order (D/O)',             'delivery_order',       '000161'),
    (21, 'unloading_charges',      'أجور التفريغ',                'Unloading Charges',                'port_charges',         '000160'),
    (22, 'labor_charges',          'أجور العمال',                 'Labor Charges',                    'other',                '10002'),
    (23, 'customs_clearance',      'أجور التخليص',                'Customs Clearance Fees',           'customs_clearance',    '10001'),
    (24, 'customs_duties',         'رسوم جمركية',                 'Customs Duties',                   'other',                '10010'),
    (25, 'electricity_charges',    'أجور كهرباء',                 'Electricity Charges',              'other',                '000066'),
    (26, 'late_fee',               'غرامة تأخير',                 'Late Fee / Delay Penalty',         'demurrage',            '000056')
  ) AS t(sort, code, name_ar, name_en, fin_service, legacy_code)
$$;

-- fin_service must be a G4 service code (status_labels fin_service); definer: no caller identity needed
CREATE OR REPLACE FUNCTION app.tg_org_service_items_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.name_ar := btrim(NEW.name_ar);
  NEW.name_en := nullif(btrim(coalesce(NEW.name_en, '')), '');
  IF NEW.fin_service IS NOT NULL AND NOT app.is_code('fin_service', NEW.fin_service) THEN
    PERFORM app.fail('MRS_INVALID', 'fin_service');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_norm ON public.org_service_items;
CREATE TRIGGER trg_norm BEFORE INSERT OR UPDATE ON public.org_service_items FOR EACH ROW EXECUTE FUNCTION app.tg_org_service_items_before();
DROP TRIGGER IF EXISTS trg_guard ON public.org_service_items;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.org_service_items FOR EACH ROW
  EXECUTE FUNCTION app.tg_guard_generic('id','org_id','code','source','legacy_code','created_by','created_at');
DROP TRIGGER IF EXISTS trg_stamp ON public.org_service_items;
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.org_service_items FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();
DROP TRIGGER IF EXISTS trg_touch ON public.org_service_items;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.org_service_items FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_audit ON public.org_service_items;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.org_service_items FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

-- seed one org with the template (missing codes only; an edited or deactivated item is never touched) → rows added
CREATE OR REPLACE FUNCTION app.seed_org_service_items(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'organization');
  END IF;
  INSERT INTO public.org_service_items (org_id, code, name_ar, name_en, fin_service, legacy_code, sort, source)
  SELECT p_org, t.code, t.name_ar, t.name_en, t.fin_service, t.legacy_code, t.sort, 'template'
    FROM app.service_items_template() t
  ON CONFLICT (org_id, code) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION app.tg_organizations_seed_service_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_org_service_items(NEW.id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_seed_service_items ON public.organizations;
CREATE TRIGGER trg_seed_service_items AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION app.tg_organizations_seed_service_items();

-- every existing org (a re-run adds nothing)
DO $seed$
DECLARE o record;
BEGIN
  FOR o IN SELECT x.id FROM public.organizations x ORDER BY x.created_at, x.id LOOP
    PERFORM app.seed_org_service_items(o.id);
  END LOOP;
END $seed$;

-- ---------------------------------------------------------------------
-- 9. cancel_transaction (void-only)
-- ---------------------------------------------------------------------
-- the shared transaction lock of G3 / G4 / G5 (20261103000100 §1, re-created): body identical + (LEGACY) a cancelled
-- transaction takes no write through any RPC that locks it — declarations, B/L links, appointments, trips, containers,
-- exceptions, costs, charges, collections, billing intents (so nothing can be billed or pushed to Daftra for it).
CREATE OR REPLACE FUNCTION app.g3_lock_tx(p_tx uuid, p_roles text[]) RETURNS public.transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.transactions;
BEGIN
  SELECT * INTO v FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v.id IS NULL OR NOT app.has_tx_role(v.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_branch_role(v.org_id, v.branch_id, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF v.cancelled_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;          -- LEGACY
  RETURN v;
END $$;

-- declaration number check (20261103000100 §3, re-created): body identical except (LEGACY) a number that was cancelled
-- together with its transaction (cancel_transaction) is free again for another transaction, like the legacy delete freed it.
-- A number cancelled on a live transaction stays reserved (G3 rule).
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
                AND d.id IS DISTINCT FROM p_exclude AND (NOT p_allow_same_tx OR d.transaction_id <> p_tx)
                AND NOT EXISTS (SELECT 1 FROM public.transactions x WHERE x.id = d.transaction_id AND x.cancelled_at IS NOT NULL)) THEN -- LEGACY
    PERFORM app.fail('MRS_INVALID', 'declaration_no_cancelled');
  END IF;
  -- legacy rows of another transaction that still carry the number (always mirrored after this migration)
  IF EXISTS (SELECT 1 FROM public.transactions t WHERE t.org_id = p_org AND t.declaration_no = p_no AND t.id <> p_tx) THEN
    PERFORM app.fail('MRS_INVALID', 'declaration_no_taken');
  END IF;
END $$;

-- cancel_transaction(p_tx, p_reason) → {transaction_id, ref, from, to 'closed', cancelled_at, event_id, declarations_cancelled}
-- Who: an ops writer of the transaction's branch (clearance staff, operations / branch manager, supervisor, admin);
-- past the declaration stage a senior role (operations / branch manager, supervisor, admin).
-- Refused (MRS_BAD_TRANSITION <why>, nothing changed): no reason (MRS_NOTE_REQUIRED reason) / > 500 (MRS_TOO_LONG reason);
--   already_cancelled; closed; billed — under billing / billed, or financial status draft_pending / invoiced / settled (a
--   Daftra draft or invoice may exist; Marsa never edits or deletes it); billing_intent — a billing intent that is not
--   cancelled; invoiced_charge; open_charges — a draft / approved client charge (void it first: once cancelled it could
--   never be voided nor billed); open_appointments; open_trips; open_exceptions; open_demurrage; open_returns — a
--   container that left the port or has a return deadline and is not returned / waived (the empty must still go back:
--   record the return or the waiver first). Cancel those first: their own RPCs keep the costs and the trail right.
-- Effect: every active customs declaration is cancelled with the same reason (declaration event, no exception: the
-- transaction itself is void), which clears the mirrored declaration number and frees it for a corrected re-entry;
-- operational_status → closed, cancelled_at / _by / cancel_reason set (the row then stays frozen and app.g3_lock_tx
-- refuses every later write); a client-visible status event (op 'cancelled', no free text) + an internal note event with
-- the reason; audit_log through trg_audit. Nothing is deleted: documents, declarations, containers, costs stay as history.
CREATE OR REPLACE FUNCTION public.cancel_transaction(p_tx uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
  v_ev bigint;
  v_at timestamptz := now();
  v_d public.customs_declarations; v_from text; v_nd int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  -- app.g3_lock_tx without its cancelled refusal (an already cancelled transaction gets its own reason below)
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  IF v_tx.cancelled_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'already_cancelled'); END IF;
  IF v_tx.operational_status = 'closed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'closed'); END IF;
  IF v_tx.operational_status IN ('under_billing','billed') OR v_tx.financial_status IN ('draft_pending','invoiced','settled') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'billed');
  END IF;
  IF app.code_sort('operational_status', v_tx.operational_status) > app.code_sort('operational_status', 'customs_declaration')
     AND NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.senior_ops_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_intents b WHERE b.transaction_id = v_tx.id AND b.status <> 'cancelled') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'billing_intent');
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.transaction_id = v_tx.id AND c.status = 'invoiced') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'invoiced_charge');
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.transaction_id = v_tx.id AND c.status IN ('draft','approved')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_charges');
  END IF;
  IF EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = v_tx.id AND a.status IN ('requested','confirmed')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_appointments');
  END IF;
  IF EXISTS (SELECT 1 FROM public.transport_trips r WHERE r.transaction_id = v_tx.id AND r.status IN ('planned','dispatched','loaded')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_trips');
  END IF;
  IF EXISTS (SELECT 1 FROM public.operational_exceptions e WHERE e.transaction_id = v_tx.id AND e.status IN ('open','in_progress')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_exceptions');
  END IF;
  IF EXISTS (SELECT 1 FROM public.demurrage_cases k WHERE k.transaction_id = v_tx.id AND k.status = 'open') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_demurrage');
  END IF;
  IF EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = v_tx.id
                AND c.return_status IN ('pending','evidence_submitted','disputed')
                AND (c.gate_out_at IS NOT NULL OR c.return_deadline IS NOT NULL)) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_returns');
  END IF;

  -- the active declarations go with the transaction (their mirror clears transactions.declaration_no before the freeze)
  FOR v_d IN SELECT * FROM public.customs_declarations d
              WHERE d.transaction_id = v_tx.id AND d.status NOT IN ('cancelled','replaced')
              ORDER BY d.created_at, d.id FOR UPDATE LOOP
    v_from := v_d.status;
    UPDATE public.customs_declarations d SET status = 'cancelled', cancelled_at = v_at, cancel_reason = v_reason
     WHERE d.id = v_d.id RETURNING * INTO v_d;
    PERFORM app.decl_event(v_d, 'cancelled', v_from, v_reason, jsonb_build_object('with_transaction', true));
    v_nd := v_nd + 1;
  END LOOP;

  UPDATE public.transactions t
     SET operational_status = 'closed', status_changed_at = v_at,
         cancelled_at = v_at, cancelled_by = auth.uid(), cancel_reason = v_reason
   WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'operational_status', v_tx.operational_status, 'closed', true, auth.uid(),
          jsonb_build_object('direction', 'forward', 'op', 'cancelled'))
  RETURNING id INTO v_ev;
  -- the reason is internal; status events visible to clients carry no free text
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'note', v_reason, false, auth.uid(), jsonb_build_object('for_event', v_ev, 'op', 'cancelled'));
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'from', v_tx.operational_status, 'to', 'closed',
                            'cancelled_at', v_at, 'event_id', v_ev, 'declarations_cancelled', v_nd);
END $$;

-- dash_management (20261106000100 §3.3, re-created): body identical except (LEGACY) a cancel (status event op 'cancelled')
-- is not a 'closed' transaction; transactions.cancelled ⇒ a new 'cancelled' count (cancelled in the period); containers of a
-- cancelled transaction are not overdue.
CREATE OR REPLACE FUNCTION public.dash_management(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_rng date[]; v_from date; v_to date; v_today date := app.rpt_today();
  v_tf timestamptz; v_tt timestamptz; v_sc uuid[]; v_fsc uuid[];
  v_req jsonb; v_trx jsonb; v_cont jsonb; v_alc int; v_by jsonb; v_fin jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  IF NOT app.has_role(p_org, app.mgmt_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(f, ARRAY['branch_id','from','to']);
  v_br := app.rpt_branch(p_org, f);
  v_rng := app.rpt_range(f, 1096);
  v_from := coalesce(v_rng[1], CASE WHEN v_rng[2] IS NOT NULL THEN date_trunc('month', v_rng[2])::date
                                    ELSE date_trunc('month', v_today)::date END);
  v_to := coalesce(v_rng[2], CASE WHEN v_rng[1] IS NOT NULL THEN (date_trunc('month', v_rng[1]) + interval '1 month - 1 day')::date
                                  ELSE (date_trunc('month', v_today) + interval '1 month - 1 day')::date END);
  IF v_from > v_to OR v_to - v_from > 1096 THEN PERFORM app.fail('MRS_INVALID', 'date_range'); END IF;
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_sc := app.rpt_scope(p_org, app.mgmt_roles());
  v_fsc := app.rpt_scope(p_org, app.fin_read_roles());

  SELECT jsonb_build_object('received', count(*), 'converted', count(*) FILTER (WHERE r.status = 'converted'),
                            'rejected', count(*) FILTER (WHERE r.status = 'rejected'))
    INTO v_req FROM public.service_requests r
   WHERE r.org_id = p_org AND r.created_at >= v_tf AND r.created_at < v_tt
     -- no branch: any mgmt role of the org (gate above); with a branch: mgmt role there
     AND (r.branch_id IS NULL OR v_sc IS NULL OR r.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR r.branch_id = v_br);

  WITH
  cr AS (SELECT t.branch_id FROM public.transactions t
          WHERE t.org_id = p_org AND t.created_at >= v_tf AND t.created_at < v_tt
            AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)),
  op AS (SELECT t.branch_id FROM public.transactions t
          WHERE t.org_id = p_org AND t.operational_status = ANY (app.rpt_open_tx())
            AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)),
  -- first operational_status event to operationally_complete / closed of each transaction, when it falls in the period
  ev AS (SELECT e.to_status st, t.branch_id, t.created_at tx_created, e.created_at at
           FROM public.transaction_events e JOIN public.transactions t ON t.id = e.transaction_id
          WHERE e.org_id = p_org AND e.event_type = 'operational_status' AND e.to_status IN ('operationally_complete','closed')
            AND e.payload ->> 'op' IS DISTINCT FROM 'cancelled'                                             -- LEGACY
            AND e.created_at >= v_tf AND e.created_at < v_tt
            AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)
            AND NOT EXISTS (SELECT 1 FROM public.transaction_events e2
                             WHERE e2.transaction_id = e.transaction_id AND e2.event_type = 'operational_status'
                               AND e2.to_status = e.to_status AND e2.payload ->> 'op' IS DISTINCT FROM 'cancelled'  -- LEGACY
                               AND (e2.created_at < e.created_at OR (e2.created_at = e.created_at AND e2.id < e.id)))),
  -- a cancelled transaction (LEGACY): counted apart, never as closed, no overdue empties
  cx AS (SELECT t.branch_id FROM public.transactions t
          WHERE t.org_id = p_org AND t.cancelled_at >= v_tf AND t.cancelled_at < v_tt
            AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br)),
  od AS (SELECT t.branch_id FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
          WHERE c.org_id = p_org AND c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline < v_today
            AND t.cancelled_at IS NULL                                                                         -- LEGACY
            AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br))
  SELECT jsonb_build_object(
           'created', (SELECT count(*) FROM cr),
           'completed', (SELECT count(*) FROM ev WHERE ev.st = 'operationally_complete'),
           'closed', (SELECT count(*) FROM ev WHERE ev.st = 'closed'),
           'cancelled', (SELECT count(*) FROM cx),                                                             -- LEGACY
           'open_now', (SELECT count(*) FROM op),
           'avg_cycle_days', (SELECT round((avg(extract(epoch FROM (ev.at - ev.tx_created)) / 86400.0))::numeric, 1)
                                FROM ev WHERE ev.st = 'operationally_complete')),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name_ar, 'branch_name_en', b.name_en,
                   'open_now', (SELECT count(*)::int FROM op WHERE op.branch_id = b.id),
                   'created', (SELECT count(*)::int FROM cr WHERE cr.branch_id = b.id),
                   'completed', (SELECT count(*)::int FROM ev WHERE ev.branch_id = b.id AND ev.st = 'operationally_complete'),
                   'overdue_now', (SELECT count(*)::int FROM od WHERE od.branch_id = b.id))
                   ORDER BY b.code, b.id), '[]'::jsonb)
            FROM public.branches b
           WHERE b.org_id = p_org AND (v_sc IS NULL OR b.id = ANY (v_sc)) AND (v_br IS NULL OR b.id = v_br)),
         jsonb_build_object('overdue_now', (SELECT count(*) FROM od),
           'returned_in_period', (SELECT count(*) FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
                                   WHERE c.org_id = p_org AND c.returned_at >= v_tf AND c.returned_at < v_tt
                                     AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
                                     AND (v_br IS NULL OR t.branch_id = v_br)))
    INTO v_trx, v_by, v_cont;

  SELECT count(*)::int INTO v_alc FROM public.operational_alerts al JOIN public.transactions t ON t.id = al.transaction_id
   WHERE al.org_id = p_org AND al.status IN ('open','acknowledged') AND al.severity = 'critical'
     AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br);

  -- finance block only from rows where the caller ALSO has fin_read (G6a-6: official = Daftra-synced, issued only;
  -- an issued invoice Daftra reported cancelled, with the G5 review item still open, is reported apart)
  IF app.has_role(p_org, app.fin_read_roles()) THEN
    WITH bi AS (SELECT i.id, i.currency::text cur, i.remote_total, i.paid_amount, app.rpt_bill_cancelled(i.id) canc
                  FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id
                 WHERE i.org_id = p_org AND i.status = 'issued' AND i.issued_at >= v_tf AND i.issued_at < v_tt
                   AND t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_fsc IS NULL OR t.branch_id = ANY (v_fsc))
                   AND (v_br IS NULL OR t.branch_id = v_br))
    SELECT jsonb_build_object(
      'official_by_currency', coalesce((SELECT jsonb_object_agg(x.cur, jsonb_build_object('issued_count', x.n, 'total', x.tot, 'paid', x.paid))
          FROM (SELECT bi.cur, count(*)::int n, round(coalesce(sum(bi.remote_total), 0), 2) tot,
                       round(coalesce(sum(coalesce(bi.paid_amount, 0)), 0), 2) paid
                  FROM bi WHERE NOT bi.canc GROUP BY 1) x), '{}'::jsonb),
      'cancelled_pending_review_by_currency', coalesce((SELECT jsonb_object_agg(x.cur, jsonb_build_object('count', x.n, 'total', x.tot))
          FROM (SELECT bi.cur, count(*)::int n, round(coalesce(sum(bi.remote_total), 0), 2) tot
                  FROM bi WHERE bi.canc GROUP BY 1) x), '{}'::jsonb),
      'payables_overdue_by_currency', coalesce((SELECT jsonb_object_agg(x.cur, x.amt)
          FROM (SELECT si.currency::text cur,
                       round(sum(greatest(app.fin_invoice_payable(si.id) - si.company_paid_amount - si.client_paid_amount, 0)), 2) amt
                  FROM public.supplier_invoices si
                 WHERE si.org_id = p_org AND si.status = 'approved' AND si.doc_type <> 'credit_note'
                   AND si.payment_status IN ('unpaid','partial') AND si.due_date < v_today
                   AND (v_fsc IS NULL OR si.branch_id = ANY (v_fsc))
                   AND (v_sc IS NULL OR si.branch_id = ANY (v_sc))
                   AND (v_br IS NULL OR si.branch_id = v_br)
                 GROUP BY 1) x), '{}'::jsonb),
      'margin_link', '#margins', 'source', 'daftra')
      INTO v_fin;
  END IF;

  RETURN jsonb_build_object('period', jsonb_build_object('from', v_from, 'to', v_to), 'requests', v_req, 'transactions', v_trx,
    'containers', v_cont, 'alerts_critical_now', v_alc, 'by_branch', v_by, 'finance', v_fin, 'branch_id', v_br,
    'generated_at', now());
END $$;

-- report / search row (20261106000100, re-created): + cancelled_at, so a cancelled transaction is told apart from a
-- closed one in search_records / report_transactions (LEGACY)
CREATE OR REPLACE FUNCTION app.rpt_tx_json(p_tx uuid, f jsonb, p_report boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', t.id, 'ref', t.ref, 'branch_id', t.branch_id, 'branch_name', b.name_ar,
           'client_id', t.client_id, 'client_name', cl.name_ar, 'client_name_en', cl.name_en,
           'operation', t.operation, 'mode', t.mode, 'operational_status', t.operational_status,
           'bl_number', t.bl_number, 'declaration_no', t.declaration_no, 'port_of_loading', t.port_of_loading,
           'port_of_discharge', t.port_of_discharge, 'shipping_line', t.shipping_line, 'eta', t.eta,
           'created_at', t.created_at, 'status_changed_at', t.status_changed_at, 'container_count', cc.n,
           'financial_status', CASE WHEN app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles()) THEN t.financial_status END,
           'matched', app.rpt_tx_matched(t.id, f),
           'cancelled_at', t.cancelled_at)                                                                     -- LEGACY
         || CASE WHEN p_report THEN jsonb_build_object('open_returns', cc.o,
              'declaration_status', (SELECT d.status FROM public.customs_declarations d WHERE d.transaction_id = t.id
                                      ORDER BY (d.status NOT IN ('cancelled','replaced')) DESC, d.created_at DESC, d.id LIMIT 1))
            ELSE '{}'::jsonb END
    FROM public.transactions t
    JOIN public.clients cl ON cl.id = t.client_id
    JOIN public.branches b ON b.id = t.branch_id
    CROSS JOIN LATERAL (SELECT count(*)::int n, (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())))::int o
                          FROM public.containers c WHERE c.transaction_id = t.id) cc
   WHERE t.id = p_tx
$$;

-- ---------------------------------------------------------------------
-- 10. column grants (fail closed: a column added later is not selectable until it is listed), internal fields,
--     conversion lists
-- ---------------------------------------------------------------------
DO $cols$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      -- 0700 + G5 hidden columns, + the internal legacy columns (staff read them through staff_internal_fields)
      ('transactions', ARRAY['notes','tracking_token_hash','financial_status','declaration_notes','cancel_reason','cancelled_by']),
      ('clients',      ARRAY['notes','classification'])) AS x(tbl, hidden)
  LOOP
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND NOT (c.column_name = ANY (r.hidden));
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', r.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, r.tbl);
  END LOOP;
  -- customs_declarations: SELECT is column-granted only (G3 §11); the two new columns are readable
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'customs_declarations' AND NOT (c.column_name = ANY (ARRAY['notes','cancel_reason']));
  EXECUTE format('GRANT SELECT (%s) ON public.customs_declarations TO authenticated', v_cols);
END $cols$;

-- staff_internal_fields: + transactions.declaration_notes / cancel_reason / cancelled_by (body otherwise = 20261105000100)
CREATE OR REPLACE FUNCTION public.staff_internal_fields(p_table text, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_ids) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'ids'); END IF;
  IF p_table = 'transactions' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(t.id::text, jsonb_build_object('notes', t.notes, 'financial_status', t.financial_status,
                                                             'declaration_notes', t.declaration_notes,           -- LEGACY
                                                             'cancel_reason', t.cancel_reason, 'cancelled_by', t.cancelled_by))
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

-- conversion lists (20261116000100 §6, re-created): + public.party_ports (test rows, deleted with the parties) and
-- + public.org_service_items (configuration, kept)
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
    'public.parties', 'public.party_ports',                                                             -- LEGACY
    'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
    'public.demurrage_cases', 'public.operational_exceptions', 'public.operational_alerts',
    -- costs (G4)
    'public.cost_accruals', 'public.cost_adjustments', 'public.cost_allocations', 'public.client_charges',
    'public.charge_collections', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.supplier_payments',
    'public.finance_documents',
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

CREATE OR REPLACE FUNCTION app.convert_keep_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.branches', 'public.memberships', 'public.org_counters', 'public.org_usage_counters',
    'public.msg_channels', 'public.msg_settings', 'public.msg_auto_reply_policies', 'public.msg_templates',
    'public.msg_instructions', 'public.daftra_connections', 'public.daftra_item_links', 'public.document_requirements',
    'public.org_subscriptions', 'public.subscription_events', 'app.ai_settings',
    'public.org_service_items',                                                                         -- LEGACY
    -- append-only / log tables
    'public.audit_log', 'public.report_exports', 'app.ai_usage', 'public.operational_alert_runs', 'public.client_errors'
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 11. RLS, policies, grants, function privileges
-- ---------------------------------------------------------------------
-- customs_ports: platform reference data, read by any signed-in user; no write grant; nothing for anon
ALTER TABLE public.customs_ports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customs_ports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customs_ports TO authenticated;
DROP POLICY IF EXISTS customs_ports_select ON public.customs_ports;
CREATE POLICY customs_ports_select ON public.customs_ports FOR SELECT TO authenticated USING (true);

-- party_ports: staff of the org read; transport writers add and (de)activate; no DELETE
ALTER TABLE public.party_ports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.party_ports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.party_ports TO authenticated;
DROP POLICY IF EXISTS party_ports_select ON public.party_ports;
CREATE POLICY party_ports_select ON public.party_ports FOR SELECT TO authenticated USING (app.is_staff(org_id));
DROP POLICY IF EXISTS party_ports_insert ON public.party_ports;
CREATE POLICY party_ports_insert ON public.party_ports FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));
DROP POLICY IF EXISTS party_ports_update ON public.party_ports;
CREATE POLICY party_ports_update ON public.party_ports FOR UPDATE TO authenticated
  USING (app.has_role(org_id, app.transport_writer_roles())) WITH CHECK (app.has_role(org_id, app.transport_writer_roles()));

-- org_service_items: staff of the org read; accounts managers / admins add and edit; no DELETE (deactivate)
ALTER TABLE public.org_service_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_service_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.org_service_items TO authenticated;
DROP POLICY IF EXISTS org_service_items_select ON public.org_service_items;
CREATE POLICY org_service_items_select ON public.org_service_items FOR SELECT TO authenticated USING (app.is_staff(org_id));
DROP POLICY IF EXISTS org_service_items_insert ON public.org_service_items;
CREATE POLICY org_service_items_insert ON public.org_service_items FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, ARRAY['accounts_manager','admin']));
DROP POLICY IF EXISTS org_service_items_update ON public.org_service_items;
CREATE POLICY org_service_items_update ON public.org_service_items FOR UPDATE TO authenticated
  USING (app.has_role(org_id, ARRAY['accounts_manager','admin'])) WITH CHECK (app.has_role(org_id, ARRAY['accounts_manager','admin']));

-- pure normalisers: callable by signed-in users and the Edge Functions (no data access); never anon
REVOKE EXECUTE ON FUNCTION app.legacy_spaces(text), app.legacy_search_key(text), app.norm_declaration_status(text),
  app.norm_declaration_type(text), app.norm_tas(text), app.norm_sa_phone(text, boolean), app.norm_chassis(text),
  app.norm_hijri_date(text), app.service_items_template()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.legacy_spaces(text), app.legacy_search_key(text), app.norm_declaration_status(text),
  app.norm_declaration_type(text), app.norm_tas(text), app.norm_sa_phone(text, boolean), app.norm_chassis(text),
  app.norm_hijri_date(text), app.service_items_template()
TO authenticated, service_role;
-- the funding matrix is a finance rule (G4: app.fin_* stay closed to API roles): SECURITY DEFINER RPCs call it
REVOKE EXECUTE ON FUNCTION app.fin_funding_check(text, text, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
-- the invoker guards run as the caller (they only call app.is_api_caller / app.guard_immutable / auth.uid)
REVOKE EXECUTE ON FUNCTION app.tg_transactions_legacy_guard(), app.tg_clients_legacy_guard(), app.tg_client_aliases_legacy()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tg_transactions_legacy_guard(), app.tg_clients_legacy_guard(), app.tg_client_aliases_legacy()
TO authenticated, service_role;
-- definer triggers + the seed: called by triggers / SECURITY DEFINER code only
REVOKE EXECUTE ON FUNCTION app.tg_transactions_legacy_norm(), app.tg_containers_legacy_roro(), app.tg_declarations_legacy_norm(),
  app.tg_party_ports_before(), app.tg_org_service_items_before(), app.tg_organizations_seed_service_items(),
  app.seed_org_service_items(uuid)
FROM PUBLIC, anon, authenticated, service_role;
-- re-created helpers keep their 20261103000100 privileges (closed)
REVOKE EXECUTE ON FUNCTION app.decl_fields(jsonb), app.decl_json(public.customs_declarations),
  app.decl_insert(public.transactions, jsonb, boolean)
FROM PUBLIC, anon, authenticated;
-- the conversion lists stay SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_keep_tables() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.cancel_transaction(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_transaction(uuid, text) TO authenticated;
-- re-created public RPCs (match_client, set_declaration_status, correct_declaration, staff_internal_fields,
-- dash_management) and helpers (app.g3_lock_tx, app.decl_no_check, app.alert_causes, app.rpt_tx_json): CREATE OR REPLACE
-- keeps their existing privileges
