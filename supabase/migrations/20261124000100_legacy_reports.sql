-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261124000100 — legacy port, step 8: reports, dashboards, alerts (التقارير ولوحات المتابعة
-- والتنبيهات) — docs/online/LEGACY_REPORTS_AR.md, plan docs/online/LEGACY_PORT_PLAN_AR.md («التقارير ولوحات المتابعة والتنبيهات
-- والواجهة», «سجل العمليات مع وصف التغيير», «الدخول برمز عبر البريد»). Builds on legacy_daftra (20261123000100), G6a
-- (20261106000100: search_records / report_* / report_exports / log_report_export), G3 (20261103000200: operational_alerts /
-- refresh_alerts), steps 1–7 (customs_ports, movements, payments register, billing intents).
-- READ SIDE + settings only: adds readers, two alert kinds, two org settings (organizations.settings keys), no table, no column,
-- no trigger (one partial index on audit_log for audit_trail); writes nothing operational, never contacts Daftra, never approves anything.
--   P. preflight (legacy_daftra applied; G6a readers / alerts / movements / payments register present) + schema_versions row
--   0. dictionaries status_labels: alert_kind (+ status_stale, appointment_not_updated), report_kind (+ movements, payments,
--                   tx_followup, fasah_recon), search_date_field (+ updated), attention_level, attention_reason, tx_daftra_state,
--                   movement_date_field, return_scope, payment_date_field, fasah_match_status, audit_label, audit_event
--   1. helpers      app.rpt_digits_no (declaration numbers: digits only, no leading zeros), app.rpt_ports, app.rpt_num_range,
--                   app.rpt_decl_status (the current declaration stage of a transaction), app.rpt_unit_count (Ro-Ro = 1),
--                   app.rpt_daftra_state / app.rpt_daftra_json / app.rpt_billed (light read of billing_intents),
--                   app.status_aging_defaults / app.status_aging_rules (org override in organizations.settings
--                   .status_aging_rules) / app.aging_rules_check, app.att_reasons / app.att_json / app.att_ids (attention),
--                   app.rpt_mv (movement rows), app.rpt_mv_keys, app.rpt_pay_keys, app.audit_label_of, app.audit_changes
--   2. re-created   app.rpt_search_keys (+ legacy register filters), app.rpt_trip_keys (+ driver / party / q), app.rpt_export_keys
--                   (+ movements, payments, tx_followup, fasah_recon), app.rpt_tx_match (+ the legacy 23-field search and its
--                   filters), app.rpt_tx_json (+ vessel, operator, agent, employee, port, unit count; report rows: containers,
--                   Daftra state for finance readers, attention), app.rpt_tx_sort + app.rpt_tx_result (+ sorts), app.alert_causes (+ status_stale,
--                   appointment_not_updated), public.report_transactions (+ attention / Daftra totals), public.report_trips
--                   (+ by_carrier / by_driver, driver / party / q filters), public.log_report_export (+ the new reports and
--                   their gates); report_exports CHECK and operational_alerts kind CHECK widened (supersets)
--   3. RPCs         dash_tx_counts, tx_attention, report_movements, report_payments, report_fasah_scope, get_status_aging_rules,
--                   set_status_aging_rules, set_email_otp_login, otp_session_check, audit_trail
--   4. privileges
-- Scoping: every reader is staff-only (clients / portal users / other orgs: MRS_FORBIDDEN), branch-scoped per row through the
-- transaction (app.rpt_scope), money only with the finance role at the row's branch (trip finance for transport values,
-- fin_read for payments and the Daftra state). Dates: Asia/Riyadh day bounds for timestamps; date columns are never shifted.
-- Owner decisions kept: billing stays blocked without the empty-return proof (nothing here changes the lifecycle); the AI never
-- approves (nothing here approves); no Daftra edits (nothing here writes billing / Daftra rows).
-- Errors: existing codes only (MRS_AUTH_REQUIRED, MRS_FORBIDDEN, MRS_INVALID <detail>, MRS_TOO_LONG <detail>, MRS_NOTE_REQUIRED,
-- MRS_NOT_FOUND); new details listed in LEGACY_REPORTS_AR.md.
-- Re-runnable (CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS + ADD / ON CONFLICT). Re-pasting 20261106000100 (G6a),
-- 20261103000200 (G3 alerts), 20261117000100 (rpt_tx_json / alert_causes) or 20261120000100 (rpt_export_keys / report CHECK) after
-- this file restores their narrower bodies: re-paste this file right after.
-- Down-path (staging only): DROP the 10 RPCs of §3 and the helpers of §1; re-paste 20261106000100 §1 / §4, 20261117000100 §5 / §9
-- (alert_causes, rpt_tx_json) and 20261120000100 (rpt_export_keys, report CHECK); then resolve the status_stale /
-- appointment_not_updated alerts (UPDATE … status 'resolved') before narrowing the kind CHECK.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261123000100') THEN
    RAISE EXCEPTION 'LEGACY REPORTS preflight: apply legacy_daftra first (schema_versions lacks 20261123000100 legacy_daftra)';
  END IF;
  IF to_regprocedure('public.report_transactions(uuid,jsonb)') IS NULL OR to_regprocedure('public.log_report_export(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.refresh_alerts(uuid)') IS NULL OR to_regprocedure('app.movement_status(public.port_appointments,public.transport_trips)') IS NULL
     OR to_regclass('public.client_disbursements') IS NULL OR to_regclass('public.customs_ports') IS NULL
     OR to_regclass('public.report_exports') IS NULL OR to_regclass('public.operational_alerts') IS NULL THEN
    RAISE EXCEPTION 'LEGACY REPORTS preflight: G6a readers / alerts / movements / payments register missing (apply 20261106000100 / 20261103000200 / 20261118000100 / 20261122000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261124000100', 'legacy_reports')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('alert_kind','status_stale',8,'معاملة متأخرة بلا تحديث','Transaction not updated',false),
  ('alert_kind','appointment_not_updated',9,'موعد مضى دون تحديث الحركة','Appointment passed, movement not updated',false),
  ('report_kind','movements',8,'تقرير المواعيد والنقل','Appointments & transport report',false),
  ('report_kind','payments',9,'كشف السدادات','Payments report',false),
  ('report_kind','tx_followup',10,'كشف متابعة المعاملات','Transactions follow-up',false),
  ('report_kind','fasah_recon',11,'المطابقة الشهرية مع فسح','Monthly Fasah reconciliation',false),
  ('search_date_field','updated',5,'آخر تحديث','Last update',false),
  ('attention_level','warning',1,'متابعة','Follow up',false),
  ('attention_level','critical',2,'متأخرة','Late',false),
  ('attention_reason','status_stale',1,'لا يوجد تحديث حديث على المعاملة','No recent update on the transaction',false),
  ('attention_reason','appointment_not_updated',2,'موعد الخروج مضى دون تحديث الحركة','The gate-out appointment passed without a movement update',false),
  ('attention_reason','empty_return_overdue',3,'تجاوز آخر موعد لإعادة الفارغ','The empty-return deadline is past',false),
  ('tx_daftra_state','none',1,'بدون فاتورة','No invoice',false),
  ('tx_daftra_state','draft',2,'مسودة دفترة','Daftra draft',false),
  ('tx_daftra_state','issued',3,'فاتورة صادرة','Issued invoice',false),
  ('tx_daftra_state','cancelled_review',4,'ملغاة في دفترة — بانتظار المراجعة','Cancelled in Daftra — review pending',false),
  ('movement_date_field','appointment',1,'تاريخ الموعد','Appointment date',false),
  ('movement_date_field','return_deadline',2,'آخر موعد لإعادة الفارغ','Empty-return deadline',false),
  ('movement_date_field','returned',3,'تاريخ الإعادة الفعلي','Actual return date',false),
  ('movement_date_field','delivered',4,'تاريخ التسليم','Delivery date',false),
  ('movement_date_field','created',5,'تاريخ الإنشاء','Created date',false),
  ('movement_date_field','updated',6,'آخر تحديث','Last update',false),
  ('return_scope','overdue',1,'متأخرة الإعادة','Return overdue',false),
  ('return_scope','pending',2,'لم تُعد بعد','Not returned yet',false),
  ('return_scope','returned',3,'أُعيدت','Returned',false),
  ('payment_date_field','paid',1,'تاريخ السداد','Payment date',false),
  ('payment_date_field','created',2,'تاريخ الإدخال','Entry date',false),
  ('fasah_match_status','matched',1,'مطابقة','Matched',false),
  ('fasah_match_status','matched_with_note',2,'مطابقة مع ملاحظة','Matched with a note',false),
  ('fasah_match_status','status_mismatch',3,'اختلاف حالة البيان','Status mismatch',false),
  ('fasah_match_status','missing',4,'غير موجودة في النظام','Missing in the system',false),
  ('fasah_match_status','port_mismatch',5,'منفذ مختلف','Port mismatch',false),
  ('fasah_match_status','ambiguous',6,'أكثر من سجل مطابق','Ambiguous',false),
  ('fasah_match_status','system_only',7,'في النظام فقط','In the system only',false),
  ('audit_label','tx.create',1,'إنشاء معاملة','Transaction created',false),
  ('audit_label','tx.update',2,'تعديل بيانات المعاملة','Transaction edited',false),
  ('audit_label','tx.status',3,'تغيير حالة المعاملة','Transaction status changed',false),
  ('audit_label','tx.cancel',4,'إلغاء المعاملة','Transaction cancelled',false),
  ('audit_label','container.add',5,'إضافة حاوية','Container added',false),
  ('audit_label','container.update',6,'تعديل حاوية','Container edited',false),
  ('audit_label','container.return',7,'تحديث إعادة الفارغ','Empty return updated',false),
  ('audit_label','container.remove',8,'حذف حاوية','Container removed',false),
  ('audit_label','appointment.add',9,'تسجيل موعد','Appointment recorded',false),
  ('audit_label','appointment.update',10,'تعديل موعد','Appointment edited',false),
  ('audit_label','appointment.status',11,'تغيير حالة الموعد','Appointment status changed',false),
  ('audit_label','trip.add',12,'تسجيل نقلة','Trip recorded',false),
  ('audit_label','trip.update',13,'تعديل نقلة','Trip edited',false),
  ('audit_label','trip.status',14,'تغيير حالة النقلة','Trip status changed',false),
  ('audit_label','declaration.add',15,'إضافة بيان جمركي','Declaration added',false),
  ('audit_label','declaration.update',16,'تعديل بيان جمركي','Declaration edited',false),
  ('audit_label','declaration.status',17,'تغيير مرحلة البيان','Declaration stage changed',false),
  ('audit_label','proof.add',18,'إضافة إثبات إعادة الفارغ','Empty-return proof added',false),
  ('audit_label','proof.update',19,'تحديث إثبات إعادة الفارغ','Empty-return proof updated',false),
  ('audit_label','payment.add',20,'تسجيل سداد','Payment recorded',false),
  ('audit_label','payment.update',21,'تعديل سداد','Payment edited',false),
  ('audit_label','payment.review',22,'مراجعة سداد','Payment reviewed',false),
  ('audit_label','payment.void',23,'إلغاء سداد','Payment voided',false),
  ('audit_label','billing.add',24,'إنشاء طلب فوترة','Billing intent created',false),
  ('audit_label','billing.update',25,'تحديث الفوترة','Billing updated',false),
  ('audit_label','client.add',26,'إضافة عميل','Client added',false),
  ('audit_label','client.update',27,'تعديل بيانات عميل','Client edited',false),
  ('audit_label','settings.update',28,'تعديل إعدادات المؤسسة','Organization settings changed',false),
  ('audit_label','row.insert',29,'إضافة سجل','Row added',false),
  ('audit_label','row.update',30,'تعديل سجل','Row edited',false),
  ('audit_label','row.delete',31,'حذف سجل','Row deleted',false),
  ('audit_event','created',1,'إنشاء المعاملة','Transaction created',false),
  ('audit_event','request_converted',2,'تحويل طلب إلى معاملة','Request converted',false),
  ('audit_event','operational_status',3,'تغيير الحالة التشغيلية','Operational status changed',false),
  ('audit_event','financial_status',4,'تغيير الحالة المالية','Financial status changed',false),
  ('audit_event','container_return',5,'إعادة الحاوية الفارغة','Empty container return',false),
  ('audit_event','document',6,'مستند','Document',false),
  ('audit_event','note',7,'ملاحظة','Note',false),
  ('audit_event','tracking_token',8,'رابط التتبع','Tracking link',false),
  ('audit_event','declaration',9,'البيان الجمركي','Customs declaration',false),
  ('audit_event','bl',10,'بوليصة الشحن','Bill of lading',false),
  ('audit_event','container',11,'الحاويات','Containers',false),
  ('audit_event','appointment',12,'المواعيد','Appointments',false),
  ('audit_event','trip',13,'النقل','Transport',false),
  ('audit_event','exception',14,'استثناء تشغيلي','Operational exception',false),
  ('audit_event','docs_override',15,'تجاوز المستندات الناقصة','Missing documents override',false),
  ('audit_event','finance',16,'المالية','Finance',false),
  ('audit_event','billing',17,'الفوترة','Billing',false),
  ('audit_event','message',18,'المراسلات','Messages',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, client_visible = EXCLUDED.client_visible;

-- the two new alert kinds (the inline G3 CHECK, default name, re-created as a superset)
ALTER TABLE public.operational_alerts DROP CONSTRAINT IF EXISTS operational_alerts_kind_check;
ALTER TABLE public.operational_alerts ADD CONSTRAINT operational_alerts_kind_check
  CHECK (kind IN ('docs_missing','appointment_soon','appointment_missed','empty_return_due','empty_return_overdue','exception_open',
                  'declaration_stalled','status_stale','appointment_not_updated'));
-- the export log: + the step-8 reports (20261120000100 CHECK, re-created as a superset)
ALTER TABLE public.report_exports DROP CONSTRAINT IF EXISTS report_exports_report_check;
ALTER TABLE public.report_exports ADD CONSTRAINT report_exports_report_check
  CHECK (report IN ('search','transactions','containers','trips','margins','costs','fasah_sheet',
                    'movements','payments','tx_followup','fasah_recon'));

-- ---------------------------------------------------------------------
-- 1. helpers (revoked from PUBLIC / anon / authenticated in §4)
-- ---------------------------------------------------------------------
-- a declaration number as Fasah prints it in its monthly report: digits only (Arabic-Indic digits too), leading zeros dropped
-- ('0' stays '0'); NULL without a digit (legacy fasahR116CleanDigits_)
CREATE OR REPLACE FUNCTION app.rpt_digits_no(p text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN d = '' THEN NULL ELSE coalesce(nullif(ltrim(d, '0'), ''), '0') END
    FROM (SELECT regexp_replace(app.to_western(coalesce(p, '')), '[^0-9]', '', 'g') d) x
$$;

-- one port code or an array of codes of public.customs_ports → text[] (NULL when absent); MRS_INVALID <k> otherwise
CREATE OR REPLACE FUNCTION app.rpt_ports(f jsonb, k text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := f -> k; r text[];
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'string' THEN
    IF btrim(v #>> '{}') = '' THEN RETURN NULL; END IF;
    r := ARRAY[upper(btrim(v #>> '{}'))];
  ELSIF jsonb_typeof(v) = 'array' THEN
    IF jsonb_array_length(v) = 0 THEN RETURN NULL; END IF;
    IF jsonb_array_length(v) > 20 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
      PERFORM app.fail('MRS_INVALID', k);
    END IF;
    SELECT array_agg(DISTINCT upper(btrim(e))) INTO r FROM jsonb_array_elements_text(v) e;
  ELSE
    PERFORM app.fail('MRS_INVALID', k);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(r) c WHERE NOT EXISTS (SELECT 1 FROM public.customs_ports p WHERE p.code = c)) THEN
    PERFORM app.fail('MRS_INVALID', k);
  END IF;
  RETURN r;
END $$;

-- an optional numeric range [min, max] (each ≥ 0, ≤ p_max); min > max → MRS_INVALID <p_detail>
CREATE OR REPLACE FUNCTION app.rpt_num_range(f jsonb, p_kmin text, p_kmax text, p_detail text, p_max numeric) RETURNS numeric[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_min numeric; v_max numeric;
BEGIN
  IF jsonb_typeof(f -> p_kmin) IN ('object','array','boolean') OR jsonb_typeof(f -> p_kmax) IN ('object','array','boolean') THEN
    PERFORM app.fail('MRS_INVALID', p_detail);
  END IF;
  v_min := app.pnum(f, p_kmin, p_max);
  v_max := app.pnum(f, p_kmax, p_max);
  IF v_min IS NOT NULL AND v_max IS NOT NULL AND v_min > v_max THEN PERFORM app.fail('MRS_INVALID', p_detail); END IF;
  RETURN ARRAY[v_min, v_max];
END $$;

-- the current declaration stage of a transaction (the same pick as the report row's declaration_status): the newest
-- declaration that is not cancelled / replaced, else the newest one; NULL without a declaration
CREATE OR REPLACE FUNCTION app.rpt_decl_status(p_tx uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.status FROM public.customs_declarations d WHERE d.transaction_id = p_tx
   ORDER BY (d.status NOT IN ('cancelled','replaced')) DESC, d.created_at DESC, d.id LIMIT 1
$$;

-- cargo units of a transaction (legacy transactionCargoUnitCountR12124_): a Ro-Ro vehicle is one unit, else the containers
CREATE OR REPLACE FUNCTION app.rpt_unit_count(p_tx uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN t.cargo_unit_type = 'roro' THEN 1
              ELSE (SELECT count(*)::int FROM public.containers c WHERE c.transaction_id = t.id) END
    FROM public.transactions t WHERE t.id = p_tx
$$;

-- the Daftra state of a transaction from its billing intents (light read, no Daftra call): issued (an issued intent; Daftra
-- reported it cancelled and the review is open → cancelled_review), draft (a Daftra draft exists: intent status draft or a
-- remote invoice id), none. Cancelled intents are ignored.
CREATE OR REPLACE FUNCTION app.rpt_daftra_state(p_tx uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN bool_or(bi.status = 'issued' AND NOT app.rpt_bill_cancelled(bi.id)) THEN 'issued'
    WHEN bool_or(bi.status = 'issued') THEN 'cancelled_review'
    WHEN bool_or(bi.status = 'draft' OR bi.external_invoice_id IS NOT NULL) THEN 'draft'
    ELSE 'none' END
    FROM (SELECT 1) one LEFT JOIN public.billing_intents bi ON bi.transaction_id = p_tx AND bi.status <> 'cancelled'
$$;
CREATE OR REPLACE FUNCTION app.rpt_daftra_json(p_tx uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('state', app.rpt_daftra_state(p_tx), 'intent_id', x.id, 'number', x.daftra_number,
                            'daftra_status', x.daftra_status, 'issued_at', x.issued_at)
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT bi.* FROM public.billing_intents bi
                        WHERE bi.transaction_id = p_tx AND bi.status <> 'cancelled' AND (bi.status IN ('issued','draft') OR bi.external_invoice_id IS NOT NULL)
                        ORDER BY (bi.status = 'issued') DESC, bi.created_at DESC, bi.id LIMIT 1) x ON true
$$;
-- Daftra-billed: an issued intent Daftra did not report cancelled (the «effective status» of the legacy attention rules)
CREATE OR REPLACE FUNCTION app.rpt_billed(p_tx uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.billing_intents bi
                  WHERE bi.transaction_id = p_tx AND bi.status = 'issued' AND NOT app.rpt_bill_cancelled(bi.id))
$$;

-- aging rules (legacy transactionAttentionRulesR12119_ + the appointment rule of getTransactionAttentionForExportR12119_), keyed by
-- the Marsa operational status: hours since the last update of the transaction → warning / critical. The legacy «نشطة» covers
-- in_progress / customs_declaration / appointment / empty_return here; billed / closed have no rule; an overdue empty return is
-- always critical (not configurable).
CREATE OR REPLACE FUNCTION app.status_aging_defaults() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '{"new": {"warning_hours": 24, "critical_hours": 48},
           "in_progress": {"warning_hours": 48, "critical_hours": 96},
           "customs_declaration": {"warning_hours": 48, "critical_hours": 96},
           "appointment": {"warning_hours": 48, "critical_hours": 96},
           "transport": {"warning_hours": 24, "critical_hours": 48},
           "empty_return": {"warning_hours": 48, "critical_hours": 96},
           "operationally_complete": {"warning_hours": 24, "critical_hours": 48},
           "under_billing": {"warning_hours": 48, "critical_hours": 96},
           "appointment_not_updated": {"warning_hours": 6, "critical_hours": 12}}'::jsonb
$$;
-- an override object {key: {warning_hours, critical_hours} | null (rule off)} → the same object, or MRS_INVALID 'aging_rule'
-- (unknown key, not an object, hours not whole numbers 1..2160, warning ≥ critical, more than the known keys)
CREATE OR REPLACE FUNCTION app.aging_rules_check(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb; w numeric; c numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'aging_rule'); END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p) LOOP
    IF NOT (app.status_aging_defaults() ? k) THEN PERFORM app.fail('MRS_INVALID', 'aging_rule'); END IF;
    CONTINUE WHEN jsonb_typeof(v) = 'null';
    IF jsonb_typeof(v) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(v) x WHERE x NOT IN ('warning_hours','critical_hours'))
       OR jsonb_typeof(v -> 'warning_hours') IS DISTINCT FROM 'number' OR jsonb_typeof(v -> 'critical_hours') IS DISTINCT FROM 'number' THEN
      PERFORM app.fail('MRS_INVALID', 'aging_rule');
    END IF;
    w := (v ->> 'warning_hours')::numeric; c := (v ->> 'critical_hours')::numeric;
    IF w <> trunc(w) OR c <> trunc(c) OR w < 1 OR c > 2160 OR w >= c THEN PERFORM app.fail('MRS_INVALID', 'aging_rule'); END IF;
  END LOOP;
  RETURN p;
END $$;
-- the effective rules of an org: defaults, then the valid entries of organizations.settings.status_aging_rules (an entry set to
-- null switches that rule off). An invalid stored entry is ignored (the default stays), never an error in a reader.
CREATE OR REPLACE FUNCTION app.status_aging_rules(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.status_aging_defaults() || coalesce((
    SELECT jsonb_object_agg(e.key, e.value)
      FROM public.organizations o CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o.settings -> 'status_aging_rules') = 'object'
                                                                     THEN o.settings -> 'status_aging_rules' ELSE '{}'::jsonb END) e
     WHERE o.id = p_org AND app.status_aging_defaults() ? e.key
       AND (jsonb_typeof(e.value) = 'null'
            OR (jsonb_typeof(e.value) = 'object' AND jsonb_typeof(e.value -> 'warning_hours') = 'number'
                AND jsonb_typeof(e.value -> 'critical_hours') = 'number'
                AND (e.value ->> 'warning_hours')::numeric >= 1 AND (e.value ->> 'critical_hours')::numeric <= 2160
                AND (e.value ->> 'warning_hours')::numeric < (e.value ->> 'critical_hours')::numeric))), '{}'::jsonb)
$$;

-- attention reasons (legacy getTransactionAttentionForExportR12119_) of the open, non-cancelled transactions of an org at p_now
-- (p_tx NULL = all of them). No branch scope here: callers scope. One row per reason:
--   status_stale            the effective status has a rule and the transaction was not updated for ≥ warning hours
--                           (effective status = 'billed' when Daftra issued an invoice that was not reported cancelled: no rule)
--   appointment_not_updated a gate-out appointment (not rescheduled / cancelled) passed ≥ 6 h (12 h critical) while its movement
--                           is still registered / incomplete, and the transaction has not reached billing
--   empty_return_overdue    an open empty return whose deadline (a DATE, Riyadh calendar) is before today — always critical
CREATE OR REPLACE FUNCTION app.att_reasons(p_org uuid, p_tx uuid[], p_now timestamptz)
RETURNS TABLE (transaction_id uuid, branch_id uuid, ref text, reason text, level text, hours numeric, since timestamptz,
               subject_id uuid, container_id uuid, container_no text, effective_status text, warning_hours int, critical_hours int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH rules AS (SELECT app.status_aging_rules(p_org) ru),
  tx AS (
    SELECT t.id, t.branch_id, t.ref, coalesce(t.updated_at, t.created_at) last_at,
           CASE WHEN app.rpt_billed(t.id) THEN 'billed' ELSE t.operational_status END eff
      FROM public.transactions t
     WHERE t.org_id = p_org AND t.cancelled_at IS NULL AND (p_tx IS NULL OR t.id = ANY (p_tx))),
  st AS (
    SELECT tx.*, (rules.ru -> tx.eff ->> 'warning_hours')::int w, (rules.ru -> tx.eff ->> 'critical_hours')::int c,
           (extract(epoch FROM (p_now - tx.last_at)) / 3600.0)::numeric h
      FROM tx CROSS JOIN rules
     WHERE jsonb_typeof(rules.ru -> tx.eff) = 'object'),
  ap AS (
    SELECT tx.id, tx.branch_id, tx.ref, tx.eff, a.id aid, a.container_id, a.appointment_at,
           (rules.ru -> 'appointment_not_updated' ->> 'warning_hours')::int w, (rules.ru -> 'appointment_not_updated' ->> 'critical_hours')::int c,
           (extract(epoch FROM (p_now - a.appointment_at)) / 3600.0)::numeric h
      FROM tx CROSS JOIN rules
      JOIN public.port_appointments a ON a.transaction_id = tx.id AND a.status NOT IN ('rescheduled','cancelled')
      LEFT JOIN public.transport_trips r ON r.id = (SELECT x.id FROM public.transport_trips x WHERE x.appointment_id = a.id
                                                      ORDER BY (x.status = 'cancelled'), x.created_at DESC, x.id LIMIT 1)
     WHERE jsonb_typeof(rules.ru -> 'appointment_not_updated') = 'object'
       AND tx.eff NOT IN ('under_billing','billed','closed')
       AND a.appointment_at IS NOT NULL AND a.appointment_at < p_now
       AND app.movement_status(a, r) IN ('registered','incomplete'))
  SELECT st.id, st.branch_id, st.ref, 'status_stale'::text, CASE WHEN st.h >= st.c THEN 'critical' ELSE 'warning' END,
         round(st.h, 1), st.last_at, NULL::uuid, NULL::uuid, NULL::text, st.eff, st.w, st.c
    FROM st WHERE st.h >= st.w
  UNION ALL
  SELECT ap.id, ap.branch_id, ap.ref, 'appointment_not_updated', CASE WHEN ap.h >= ap.c THEN 'critical' ELSE 'warning' END,
         round(ap.h, 1), ap.appointment_at, ap.aid, ap.container_id, k.container_no, ap.eff, ap.w, ap.c
    FROM ap LEFT JOIN public.containers k ON k.id = ap.container_id
   WHERE ap.h >= ap.w
  UNION ALL
  SELECT tx.id, tx.branch_id, tx.ref, 'empty_return_overdue', 'critical',
         round((extract(epoch FROM (p_now - app.rpt_ts(c.return_deadline + 1))) / 3600.0)::numeric, 1),
         app.rpt_ts(c.return_deadline + 1), c.id, c.id, c.container_no, tx.eff, NULL::int, NULL::int
    FROM tx JOIN public.containers c ON c.transaction_id = tx.id
   WHERE c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline IS NOT NULL AND c.returned_at IS NULL
     AND c.return_deadline < (p_now AT TIME ZONE 'Asia/Riyadh')::date
$$;

-- one transaction's attention → {level, hours, reasons:[{code, level, hours, since, subject_id, container_id, container_no,
-- status, warning_hours, critical_hours}]} (critical first, then the oldest), or NULL when nothing needs attention
CREATE OR REPLACE FUNCTION app.att_json(p_org uuid, p_tx uuid, p_now timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
           'level', CASE WHEN bool_or(x.level = 'critical') THEN 'critical' ELSE 'warning' END,
           'hours', max(x.hours),
           'reasons', jsonb_agg(jsonb_build_object('code', x.reason, 'level', x.level, 'hours', x.hours, 'since', x.since,
                        'subject_id', x.subject_id, 'container_id', x.container_id, 'container_no', x.container_no,
                        'status', x.effective_status, 'warning_hours', x.warning_hours, 'critical_hours', x.critical_hours)
                      ORDER BY (x.level = 'critical') DESC, x.hours DESC, x.reason, x.subject_id)) END
    FROM app.att_reasons(p_org, ARRAY[p_tx], p_now) x
$$;

-- the transactions of an org with attention at p_now: p_level any | warning (no critical reason) | critical
CREATE OR REPLACE FUNCTION app.att_ids(p_org uuid, p_level text, p_now timestamptz) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(g.transaction_id), '{}'::uuid[])
    FROM (SELECT x.transaction_id, bool_or(x.level = 'critical') crit FROM app.att_reasons(p_org, NULL, p_now) x GROUP BY 1) g
   WHERE p_level = 'any' OR (p_level = 'critical' AND g.crit) OR (p_level = 'warning' AND NOT g.crit)
$$;

-- movement rows of an org (legacy «حركة النقل»: every appointment that is not a rescheduled one, with its trip — the same pick as
-- list_movements —, plus the trips without an appointment). No branch scope / money gate here: report_movements applies them.
CREATE OR REPLACE FUNCTION app.rpt_mv(p_org uuid)
RETURNS TABLE (id uuid, kind text, appointment_id uuid, trip_id uuid, transaction_id uuid, branch_id uuid, ref text, client_id uuid,
               client_name text, port_code text, port_name text, container_id uuid, container_no text, declaration_no text,
               bl_number text, appointment_at timestamptz, appointment_no text, booking_ref text, appointment_status text,
               operator_name text, driver_id uuid, driver_name text, driver_phone text, truck_id uuid, truck_plate text,
               carrier_id uuid, party_type text, party_name text, transport_order_no text, origin text, destination text,
               trip_status text, delivered_at timestamptz, cost_amount numeric, cost_currency text, sell_amount numeric,
               sell_currency text, movement_status text, return_location text, return_deadline date, returned_at timestamptz,
               return_status text, notes text, created_by uuid, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(a.id, r.id), CASE WHEN a.id IS NULL THEN 'trip' ELSE 'appointment' END, a.id, r.id, t.id, t.branch_id, t.ref,
         t.client_id, cl.name_ar, t.port_code, cp.name_ar, coalesce(a.container_id, r.container_id), c.container_no,
         coalesce(t.declaration_no, (SELECT d.declaration_no FROM public.customs_declarations d WHERE d.transaction_id = t.id
                                      ORDER BY (d.status NOT IN ('cancelled','replaced')) DESC, d.created_at DESC, d.id LIMIT 1)),
         t.bl_number, a.appointment_at, a.appointment_no, a.booking_ref, a.status, coalesce(a.operator_name, tp.name_ar),
         dr.id, dr.full_name, dr.phone, tk.id, tk.plate_no, r.carrier_id, r.party_type, coalesce(r.party_name, ca.name_ar),
         coalesce(r.transport_order_no, t.transport_order_no), r.origin, r.destination, r.status, r.unloaded_at,
         r.cost_amount, r.cost_currency, r.sell_amount, r.sell_currency, app.movement_status(a, r),
         coalesce(c.return_location, yd.name_ar), c.return_deadline, c.returned_at, c.return_status, r.notes,
         coalesce(a.created_by, r.created_by), least(a.created_at, r.created_at), greatest(a.updated_at, r.updated_at)
    FROM (SELECT a0.id aid, (SELECT x.id FROM public.transport_trips x WHERE x.appointment_id = a0.id
                              ORDER BY (x.status = 'cancelled'), x.created_at DESC, x.id LIMIT 1) rid
            FROM public.port_appointments a0 WHERE a0.org_id = p_org AND a0.status <> 'rescheduled'
          UNION ALL
          SELECT NULL::uuid, r0.id FROM public.transport_trips r0 WHERE r0.org_id = p_org AND r0.appointment_id IS NULL) k
    LEFT JOIN public.port_appointments a ON a.id = k.aid
    LEFT JOIN public.transport_trips r ON r.id = k.rid
    JOIN public.transactions t ON t.id = coalesce(a.transaction_id, r.transaction_id) AND t.org_id = p_org
    JOIN public.clients cl ON cl.id = t.client_id
    LEFT JOIN public.customs_ports cp ON cp.code = t.port_code
    LEFT JOIN public.containers c ON c.id = coalesce(a.container_id, r.container_id)
    LEFT JOIN public.parties tp ON tp.id = a.terminal_party_id
    LEFT JOIN public.parties ca ON ca.id = r.carrier_id
    LEFT JOIN public.parties yd ON yd.id = c.return_yard_party_id
    LEFT JOIN public.drivers dr ON dr.id = coalesce(r.driver_id, a.driver_id)
    LEFT JOIN public.trucks tk ON tk.id = coalesce(r.truck_id, a.truck_id)
$$;

-- filter keys of the step-8 readers (logged keys = these minus limit / offset)
CREATE OR REPLACE FUNCTION app.rpt_mv_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['branch_id','transaction_id','client_id','client_q','driver_id','driver_q','truck_q','carrier_id','party_type','party_q',
               'movement_status','bl_number','declaration_no','container_no','port_code','return_status','return_scope','destination_q',
               'booking_q','operator_q','employee_id','date_field','from','to','value_min','value_max','revenue_min','revenue_max','q',
               'sort','limit','offset']
$$;
CREATE OR REPLACE FUNCTION app.rpt_pay_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['branch_id','transaction_id','client_id','client_q','service_item_id','service_code','funding_source','method',
               'review_status','movement_type','pattern','status','date_field','from','to','q','sort','limit','offset']
$$;

-- audit trail: the business label of one audit row (table + action + the fields that changed) — an 'audit_label' code
CREATE OR REPLACE FUNCTION app.audit_label_of(p_table text, p_action text, p_changed text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_table
    WHEN 'transactions' THEN CASE WHEN p_action = 'INSERT' THEN 'tx.create'
                                  WHEN 'cancelled_at' = ANY (p_changed) THEN 'tx.cancel'
                                  WHEN 'operational_status' = ANY (p_changed) THEN 'tx.status' ELSE 'tx.update' END
    WHEN 'containers' THEN CASE WHEN p_action = 'INSERT' THEN 'container.add' WHEN p_action = 'DELETE' THEN 'container.remove'
                                WHEN p_changed && ARRAY['return_status','returned_at','return_deadline','return_location'] THEN 'container.return'
                                ELSE 'container.update' END
    WHEN 'port_appointments' THEN CASE WHEN p_action = 'INSERT' THEN 'appointment.add'
                                       WHEN 'status' = ANY (p_changed) THEN 'appointment.status' ELSE 'appointment.update' END
    WHEN 'transport_trips' THEN CASE WHEN p_action = 'INSERT' THEN 'trip.add'
                                     WHEN 'status' = ANY (p_changed) THEN 'trip.status' ELSE 'trip.update' END
    WHEN 'customs_declarations' THEN CASE WHEN p_action = 'INSERT' THEN 'declaration.add'
                                          WHEN 'status' = ANY (p_changed) THEN 'declaration.status' ELSE 'declaration.update' END
    WHEN 'empty_return_proofs' THEN CASE WHEN p_action = 'INSERT' THEN 'proof.add' ELSE 'proof.update' END
    WHEN 'client_disbursements' THEN CASE WHEN p_action = 'INSERT' THEN 'payment.add'
                                          WHEN 'status' = ANY (p_changed) THEN 'payment.void'
                                          WHEN 'review_status' = ANY (p_changed) THEN 'payment.review' ELSE 'payment.update' END
    WHEN 'billing_intents' THEN CASE WHEN p_action = 'INSERT' THEN 'billing.add' ELSE 'billing.update' END
    WHEN 'clients' THEN CASE WHEN p_action = 'INSERT' THEN 'client.add' ELSE 'client.update' END
    WHEN 'organizations' THEN 'settings.update'
    ELSE CASE p_action WHEN 'INSERT' THEN 'row.insert' WHEN 'DELETE' THEN 'row.delete' ELSE 'row.update' END END
$$;
-- the field-level changes of one audit row → [{field, from, to}] (UPDATE: the changed fields; INSERT: the set fields; DELETE:
-- the fields the row had), technical fields left out, ≤ 60 entries, ordered by field name
CREATE OR REPLACE FUNCTION app.audit_changes(p_action text, p_changed text[], p_old jsonb, p_new jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('field', x.k, 'from', p_old -> x.k, 'to', p_new -> x.k) ORDER BY x.k), '[]'::jsonb)
    FROM (SELECT k FROM (
            SELECT unnest(p_changed) k WHERE p_action = 'UPDATE'
            UNION SELECT e.key FROM jsonb_each(coalesce(p_new, '{}'::jsonb)) e WHERE p_action = 'INSERT' AND jsonb_typeof(e.value) <> 'null'
            UNION SELECT e.key FROM jsonb_each(coalesce(p_old, '{}'::jsonb)) e WHERE p_action = 'DELETE' AND jsonb_typeof(e.value) <> 'null') y
           WHERE y.k NOT IN ('id','org_id','created_at','updated_at','created_by','updated_by','version','seq','search_key',
                             'tracking_token_hash','token_hash')
           ORDER BY y.k LIMIT 60) x
$$;

-- ---------------------------------------------------------------------
-- 2. re-created readers (G6a / step-1 bodies; the step-8 changes are marked "-- RPT")
-- ---------------------------------------------------------------------
-- search / report_transactions keys (20261106000100): + the legacy register filters (applyTransactionFilters_)
CREATE OR REPLACE FUNCTION app.rpt_search_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['q','declaration_no','bl_number','container_no','client_id','client_q','carrier_id','carrier_q','port',
               'date_field','from','to','branch_id','operational_status','sort','limit','offset',
               -- RPT
               'client_code','client_category','port_code','declaration_status','vessel','terminal_party_id','operator_q','agent_q',
               'employee_id','containers_min','containers_max','cargo_unit_type','transaction_type','daftra_state','attention']
$$;
-- report_trips keys (20261106000100): + the transport report filters (applyTransportReportFiltersR12_)
CREATE OR REPLACE FUNCTION app.rpt_trip_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['branch_id','client_id','carrier_id','status','from','to','late','include_finance','sort','limit','offset',
               'driver_id','driver_q','party_type','party_q','q']                                                     -- RPT
$$;
-- allowed (logged) filter keys per report (20261120000100): + the step-8 reports
CREATE OR REPLACE FUNCTION app.rpt_export_keys(p_report text) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT array(SELECT k FROM unnest(CASE p_report
      WHEN 'search' THEN app.rpt_search_keys()
      WHEN 'transactions' THEN app.rpt_search_keys()
      WHEN 'containers' THEN app.rpt_container_keys()
      WHEN 'trips' THEN app.rpt_trip_keys()
      WHEN 'margins' THEN ARRAY['branch_id','client_id','from','to','operational_status','level','currency']
      WHEN 'costs' THEN ARRAY['group_by','from','to','branch_id','client_id','supplier_id','service_code','level','currency','include_overhead']
      WHEN 'fasah_sheet' THEN ARRAY['transaction_id']
      WHEN 'movements' THEN app.rpt_mv_keys()                                                                         -- RPT
      WHEN 'payments' THEN app.rpt_pay_keys()                                                                         -- RPT
      WHEN 'tx_followup' THEN app.rpt_search_keys()                                                                   -- RPT
      WHEN 'fasah_recon' THEN ARRAY['months','port_codes','files','statuses','system_only']                                         -- RPT
      ELSE ARRAY[]::text[] END) k WHERE k NOT IN ('limit','offset'))
$$;

-- shared transaction matcher (20261106000100 §1, re-created). RPT: + client Daftra code / category, port code, declaration stage,
-- vessel, terminal operator, shipping agent, employee, cargo-unit count range, cargo-unit type, transaction type, Daftra state
-- (finance readers only: rows outside the caller's fin_read scope never match it), attention (late only), date field 'updated',
-- and the legacy 23-field free text (chassis / plate, vessel, operator, agent, employee, transport order, notes, Daftra code).
CREATE OR REPLACE FUNCTION app.rpt_tx_match(p_org uuid, f jsonb) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_q text; v_qp text; v_qw text; v_qn text; v_qc text; v_decl text; v_bl text; v_cno text; v_cl uuid; v_clq text; v_clw text;
  v_car uuid; v_carq text; v_port text; v_df text; v_rng date[]; v_from date; v_to date; v_tf timestamptz; v_tt timestamptz;
  v_br uuid; v_st text[]; v_sc uuid[];
  -- RPT
  v_ccode text; v_ccat text[]; v_ports text[]; v_ds text[]; v_vessel text; v_op uuid; v_opq text; v_agq text; v_emp uuid;
  v_cr numeric[]; v_cmin int; v_cmax int; v_cu text[]; v_tty text[]; v_dst text[]; v_fsc uuid[]; v_att text; v_attids uuid[];
BEGIN
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(v_q);
  v_qw := app.rpt_like(app.to_western(v_q));
  v_qn := app.rpt_like(app.rpt_norm_no(v_q));
  v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_decl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'declaration_no', 80)));
  v_bl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'bl_number', 80)));
  v_cno := app.rpt_like(app.rpt_norm_container(app.ptext(f, 'container_no', 80)));
  v_cl := app.puuid(f, 'client_id');
  v_clq := app.rpt_like(app.ptext(f, 'client_q', 80));
  v_clw := app.rpt_like(app.to_western(app.ptext(f, 'client_q', 80)));
  v_car := app.puuid(f, 'carrier_id');
  v_carq := app.rpt_like(app.ptext(f, 'carrier_q', 80));
  v_port := app.rpt_like(app.ptext(f, 'port', 80));
  v_df := coalesce(app.ptext(f, 'date_field', 20), 'created');
  IF v_df NOT IN ('created','eta','declaration','status_changed','updated') THEN PERFORM app.fail('MRS_INVALID', 'date_field'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_br := app.rpt_branch(p_org, f);
  v_st := app.rpt_codes(f, 'operational_status', 'operational_status');
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  -- RPT
  v_ccode := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'client_code', 40)));
  v_ccat := app.rpt_codes(f, 'client_category', 'client_port_category');
  v_ports := app.rpt_ports(f, 'port_code');
  v_ds := app.rpt_codes(f, 'declaration_status', 'declaration_status');
  v_vessel := app.rpt_like(app.ptext(f, 'vessel', 80));
  v_op := app.puuid(f, 'terminal_party_id');
  v_opq := app.rpt_like(app.ptext(f, 'operator_q', 80));
  v_agq := app.rpt_like(app.ptext(f, 'agent_q', 80));
  v_emp := app.puuid(f, 'employee_id');
  v_cr := app.rpt_num_range(f, 'containers_min', 'containers_max', 'containers_range', 1000);
  v_cmin := v_cr[1]::int; v_cmax := v_cr[2]::int;
  v_cu := app.rpt_codes(f, 'cargo_unit_type', 'cargo_unit_type');
  v_tty := app.rpt_codes(f, 'transaction_type', 'transaction_type');
  v_dst := app.rpt_codes(f, 'daftra_state', 'tx_daftra_state');
  IF v_dst IS NOT NULL THEN v_fsc := app.rpt_scope(p_org, app.fin_read_roles()); END IF;
  v_att := app.ptext(f, 'attention', 10);
  IF v_att IS NOT NULL THEN
    IF v_att NOT IN ('any','warning','critical') THEN PERFORM app.fail('MRS_INVALID', 'attention'); END IF;
    v_attids := app.att_ids(p_org, v_att, now());
  END IF;
  RETURN QUERY
  SELECT t.id FROM public.transactions t JOIN public.clients cl ON cl.id = t.client_id
   WHERE t.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_st IS NULL OR t.operational_status = ANY (v_st))
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_q IS NULL
          OR t.ref ILIKE v_qp OR t.ref ILIKE v_qn OR t.bl_number ILIKE v_qn OR t.declaration_no ILIKE v_qn
          OR cl.name_ar ILIKE v_qp OR cl.name_en ILIKE v_qp OR cl.name_ar ILIKE v_qw OR cl.name_en ILIKE v_qw
          OR cl.cr_number ILIKE v_qw OR cl.vat_number ILIKE v_qw
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.bl_number ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = t.id AND c.container_no ILIKE v_qc)
          -- RPT: the rest of the legacy 23 fields
          OR cl.daftra_client_code ILIKE v_qn OR t.chassis_no ILIKE v_qn OR t.vehicle_plate_no ILIKE v_qn
          OR t.transport_order_no ILIKE v_qn OR t.port_code ILIKE v_qn OR t.shipping_line ILIKE v_qp
          OR t.port_of_loading ILIKE v_qp OR t.port_of_discharge ILIKE v_qp
          OR t.notes ILIKE v_qp OR t.declaration_notes ILIKE v_qp
          OR EXISTS (SELECT 1 FROM public.customs_ports cp WHERE cp.code = t.port_code AND (cp.name_ar ILIKE v_qp OR cp.name_en ILIKE v_qp))
          OR EXISTS (SELECT 1 FROM public.transaction_shipment_data sd WHERE sd.transaction_id = t.id AND sd.vessel ILIKE v_qp)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      LEFT JOIN public.parties ag ON ag.id = b.shipping_agent_id
                      WHERE tb.transaction_id = t.id AND (b.vessel ILIKE v_qp OR b.carrier_name ILIKE v_qp OR ag.name_ar ILIKE v_qp
                                                          OR ag.name_en ILIKE v_qp))
          OR EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id IN (t.terminal_party_id, t.transport_party_id)
                      AND (pa.name_ar ILIKE v_qp OR pa.name_en ILIKE v_qp))
          OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = coalesce(t.responsible_user_id, t.created_by) AND pr.full_name ILIKE v_qp))
     AND (v_decl IS NULL OR t.declaration_no ILIKE v_decl
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no ILIKE v_decl))
     AND (v_bl IS NULL OR t.bl_number ILIKE v_bl
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.bl_number ILIKE v_bl))
     AND (v_cno IS NULL OR EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = t.id AND c.container_no ILIKE v_cno)
          OR t.chassis_no ILIKE v_cno OR t.vehicle_plate_no ILIKE v_cno)                                            -- RPT (Ro-Ro)
     AND (v_clq IS NULL OR cl.name_ar ILIKE v_clq OR cl.name_en ILIKE v_clq OR cl.name_ar ILIKE v_clw OR cl.name_en ILIKE v_clw
          OR cl.cr_number ILIKE v_clw OR cl.vat_number ILIKE v_clw)
     AND (v_car IS NULL
          OR EXISTS (SELECT 1 FROM public.transport_trips tr WHERE tr.transaction_id = t.id AND tr.carrier_id = v_car)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.shipping_agent_id = v_car))
     AND (v_carq IS NULL OR t.shipping_line ILIKE v_carq
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.carrier_name ILIKE v_carq)
          OR EXISTS (SELECT 1 FROM public.transport_trips tr JOIN public.parties pa ON pa.id = tr.carrier_id
                      WHERE tr.transaction_id = t.id AND (pa.name_ar ILIKE v_carq OR pa.name_en ILIKE v_carq)))
     AND (v_port IS NULL OR t.port_of_loading ILIKE v_port OR t.port_of_discharge ILIKE v_port
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND (b.port_of_loading ILIKE v_port OR b.port_of_discharge ILIKE v_port))
          OR EXISTS (SELECT 1 FROM public.customs_ports cp WHERE cp.code = t.port_code                              -- RPT
                      AND (cp.name_ar ILIKE v_port OR cp.name_en ILIKE v_port OR cp.code ILIKE v_port)))
     -- RPT: the legacy register filters
     AND (v_ccode IS NULL OR cl.daftra_client_code ILIKE v_ccode)
     AND (v_ccat IS NULL OR cl.port_category = ANY (v_ccat))
     AND (v_ports IS NULL OR t.port_code = ANY (v_ports))
     AND (v_ds IS NULL OR app.rpt_decl_status(t.id) = ANY (v_ds))
     AND (v_vessel IS NULL
          OR EXISTS (SELECT 1 FROM public.transaction_shipment_data sd WHERE sd.transaction_id = t.id AND sd.vessel ILIKE v_vessel)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.vessel ILIKE v_vessel))
     AND (v_op IS NULL OR t.terminal_party_id = v_op
          OR EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = t.id AND a.terminal_party_id = v_op))
     AND (v_opq IS NULL
          OR EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id = t.terminal_party_id AND (pa.name_ar ILIKE v_opq OR pa.name_en ILIKE v_opq))
          OR EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = t.id AND a.operator_name ILIKE v_opq))
     AND (v_agq IS NULL OR t.shipping_line ILIKE v_agq
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      LEFT JOIN public.parties ag ON ag.id = b.shipping_agent_id
                      WHERE tb.transaction_id = t.id AND (b.carrier_name ILIKE v_agq OR ag.name_ar ILIKE v_agq OR ag.name_en ILIKE v_agq)))
     AND (v_emp IS NULL OR coalesce(t.responsible_user_id, t.created_by) = v_emp)
     AND (v_cmin IS NULL OR app.rpt_unit_count(t.id) >= v_cmin)
     AND (v_cmax IS NULL OR app.rpt_unit_count(t.id) <= v_cmax)
     AND (v_cu IS NULL OR t.cargo_unit_type = ANY (v_cu))
     AND (v_tty IS NULL OR t.transaction_type = ANY (v_tty))
     AND (v_dst IS NULL OR ((v_fsc IS NULL OR t.branch_id = ANY (v_fsc)) AND app.rpt_daftra_state(t.id) = ANY (v_dst)))
     AND (v_att IS NULL OR t.id = ANY (v_attids))
     -- one predicate per date field (each folds away in the custom plan unless it is the chosen one)
     AND (v_df <> 'created' OR ((v_tf IS NULL OR t.created_at >= v_tf) AND (v_tt IS NULL OR t.created_at < v_tt)))
     AND (v_df <> 'updated' OR ((v_tf IS NULL OR t.updated_at >= v_tf) AND (v_tt IS NULL OR t.updated_at < v_tt)))  -- RPT
     AND (v_df <> 'status_changed' OR ((v_tf IS NULL OR t.status_changed_at >= v_tf) AND (v_tt IS NULL OR t.status_changed_at < v_tt)))
     AND (v_df <> 'eta' OR ((v_from IS NULL OR t.eta >= v_from) AND (v_to IS NULL OR t.eta <= v_to)))
     AND (v_df <> 'declaration' OR (v_from IS NULL AND v_to IS NULL)
          OR app.rpt_in(t.declaration_date, v_from, v_to)
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.status <> 'cancelled'
                       AND app.rpt_in(d.declaration_date, v_from, v_to)));
END $$;

-- report / search row (20261117000100, re-created). RPT: + port, terminal operator, shipping agent, vessel, employee, client Daftra
-- code / category, cargo unit fields, transaction type, declaration date, unit count, updated_at, transport order; report rows also
-- carry the container numbers (≤ 50, tooltip), the Daftra state (fin_read at the row's branch, else null) and the attention.
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
           'cancelled_at', t.cancelled_at)
         || jsonb_build_object(                                                                                    -- RPT
           'port_code', t.port_code, 'port_name', cp.name_ar, 'port_name_en', cp.name_en,
           'terminal_party_id', t.terminal_party_id,
           'operator_name', coalesce(tp.name_ar, (SELECT a.operator_name FROM public.port_appointments a
                                                   WHERE a.transaction_id = t.id AND a.operator_name IS NOT NULL AND a.status <> 'cancelled'
                                                   ORDER BY a.appointment_at DESC NULLS LAST, a.id LIMIT 1)),
           'agent_name', coalesce(bl.agent_name, bl.carrier_name, t.shipping_line),
           'vessel', coalesce(sd.vessel, bl.vessel),
           'employee_id', coalesce(t.responsible_user_id, t.created_by), 'employee_name', pr.full_name,
           'client_code', cl.daftra_client_code, 'client_category', cl.port_category,
           'cargo_unit_type', t.cargo_unit_type, 'chassis_no', t.chassis_no, 'vehicle_plate_no', t.vehicle_plate_no,
           'transaction_type', t.transaction_type, 'transport_mode', t.transport_mode, 'transport_order_no', t.transport_order_no,
           'declaration_date', coalesce(t.declaration_date, (SELECT d.declaration_date FROM public.customs_declarations d
                                                              WHERE d.transaction_id = t.id AND d.status NOT IN ('cancelled','replaced')
                                                              ORDER BY d.created_at DESC, d.id LIMIT 1)),
           'unit_count', CASE WHEN t.cargo_unit_type = 'roro' THEN 1 ELSE cc.n END, 'updated_at', t.updated_at)
         || CASE WHEN p_report THEN jsonb_build_object('open_returns', cc.o,
              'declaration_status', app.rpt_decl_status(t.id),
              'containers', coalesce((SELECT jsonb_agg(z.container_no ORDER BY z.container_no)                      -- RPT
                                        FROM (SELECT c.container_no FROM public.containers c WHERE c.transaction_id = t.id
                                               ORDER BY c.container_no LIMIT 50) z), '[]'::jsonb),
              'daftra', CASE WHEN app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles())                  -- RPT
                             THEN app.rpt_daftra_json(t.id) END,
              'attention', app.att_json(t.org_id, t.id, now()))                                                    -- RPT
            ELSE '{}'::jsonb END
    FROM public.transactions t
    JOIN public.clients cl ON cl.id = t.client_id
    JOIN public.branches b ON b.id = t.branch_id
    LEFT JOIN public.customs_ports cp ON cp.code = t.port_code
    LEFT JOIN public.parties tp ON tp.id = t.terminal_party_id
    LEFT JOIN public.profiles pr ON pr.id = coalesce(t.responsible_user_id, t.created_by)
    LEFT JOIN public.transaction_shipment_data sd ON sd.transaction_id = t.id
    LEFT JOIN LATERAL (SELECT b2.vessel, b2.carrier_name, ag.name_ar agent_name
                         FROM public.transaction_bls tb JOIN public.bills_of_lading b2 ON b2.id = tb.bl_id
                         LEFT JOIN public.parties ag ON ag.id = b2.shipping_agent_id
                        WHERE tb.transaction_id = t.id ORDER BY tb.is_primary DESC, tb.created_at, b2.id LIMIT 1) bl ON true
    CROSS JOIN LATERAL (SELECT count(*)::int n, (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())))::int o
                          FROM public.containers c WHERE c.transaction_id = t.id) cc
   WHERE t.id = p_tx
$$;

-- sort key (20261106000100): + ref_desc (legacy default: newest sequence first), declaration date, last update
CREATE OR REPLACE FUNCTION app.rpt_tx_sort(f jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := coalesce(app.ptext(f, 'sort', 30), 'created_desc');
BEGIN
  IF v NOT IN ('created_desc','created_asc','ref','eta','status_changed_desc',
               'ref_desc','declaration_date_desc','declaration_date_asc','updated_desc') THEN                       -- RPT
    PERFORM app.fail('MRS_INVALID', 'sort');
  END IF;
  RETURN v;
END $$;

-- ordered page + total + fingerprint (20261106000100, re-created): + the step-8 sorts
CREATE OR REPLACE FUNCTION app.rpt_tx_result(p_ids uuid[], f jsonb, p_sort text, p_limit int, p_offset int, p_report boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_items jsonb; v_total int; v_fp text;
BEGIN
  SELECT count(*)::int, md5(coalesce(string_agg(t.id::text || ':' || coalesce(t.updated_at::text, ''), ',' ORDER BY t.id), ''))
    INTO v_total, v_fp FROM public.transactions t WHERE t.id = ANY (coalesce(p_ids, '{}'::uuid[]));
  SELECT coalesce(jsonb_agg(app.rpt_tx_json(p.id, f, p_report) ORDER BY p.o), '[]'::jsonb) INTO v_items
    FROM (SELECT t.id, row_number() OVER (ORDER BY
                   CASE WHEN p_sort = 'created_desc' THEN t.created_at END DESC,
                   CASE WHEN p_sort = 'created_asc' THEN t.created_at END ASC,
                   CASE WHEN p_sort = 'ref' THEN t.ref END ASC,
                   CASE WHEN p_sort = 'ref_desc' THEN t.ref END DESC,                                                -- RPT
                   CASE WHEN p_sort = 'eta' THEN t.eta END ASC NULLS LAST,
                   CASE WHEN p_sort = 'status_changed_desc' THEN t.status_changed_at END DESC,
                   CASE WHEN p_sort = 'declaration_date_desc' THEN t.declaration_date END DESC NULLS LAST,           -- RPT
                   CASE WHEN p_sort = 'declaration_date_asc' THEN t.declaration_date END ASC NULLS LAST,             -- RPT
                   CASE WHEN p_sort = 'updated_desc' THEN t.updated_at END DESC,                                    -- RPT
                   t.id) o
            FROM public.transactions t WHERE t.id = ANY (coalesce(p_ids, '{}'::uuid[]))) p
   WHERE p.o > p_offset AND p.o <= p_offset + p_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', p_limit, 'offset', p_offset, 'fingerprint', v_fp);
END $$;

-- 5.1 report_transactions (20261106000100, re-created). RPT: totals + attention {critical, warning} (now) and, for finance readers,
-- by_daftra_state over the rows of their fin_read scope (others: null).
CREATE OR REPLACE FUNCTION public.report_transactions(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_sort text; v_limit int; v_offset int; v_ids uuid[]; v_tot jsonb; v_by jsonb;
        v_att jsonb; v_dft jsonb; v_fsc uuid[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_search_keys());
  v_sort := app.rpt_tx_sort(f);
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  SELECT array_agg(m) INTO v_ids FROM app.rpt_tx_match(p_org, f) m;
  SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_by
    FROM (SELECT t.operational_status s, count(*)::int n FROM public.transactions t
           WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[])) GROUP BY 1) x;
  SELECT jsonb_build_object('count', count(DISTINCT t.id)::int,
           'containers', coalesce(sum(cc.n), 0)::int, 'open_returns', coalesce(sum(cc.o), 0)::int, 'by_status', v_by,
           -- RPT: the sum of the rows' unit_count (a Ro-Ro vehicle = 1), what the register's «عدد الوحدات» totals row shows
           'units', coalesce(sum(CASE WHEN t.cargo_unit_type = 'roro' THEN 1 ELSE cc.n END), 0)::int)
    INTO v_tot
    FROM public.transactions t
    CROSS JOIN LATERAL (SELECT count(*)::int n, (count(*) FILTER (WHERE c.return_status = ANY (app.rpt_open_returns())))::int o
                          FROM public.containers c WHERE c.transaction_id = t.id) cc
   WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[]));
  -- RPT
  SELECT jsonb_build_object('critical', count(*) FILTER (WHERE g.crit)::int, 'warning', count(*) FILTER (WHERE NOT g.crit)::int,
                            'total', count(*)::int)
    INTO v_att
    FROM (SELECT x.transaction_id, bool_or(x.level = 'critical') crit
            FROM app.att_reasons(p_org, coalesce(v_ids, '{}'::uuid[]), now()) x GROUP BY 1) g;
  IF app.has_role(p_org, app.fin_read_roles()) THEN
    v_fsc := app.rpt_scope(p_org, app.fin_read_roles());
    SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_dft
      FROM (SELECT app.rpt_daftra_state(t.id) s, count(*)::int n FROM public.transactions t
             WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[])) AND (v_fsc IS NULL OR t.branch_id = ANY (v_fsc)) GROUP BY 1) x;
  END IF;
  v_tot := v_tot || jsonb_build_object('attention', v_att, 'by_daftra_state', v_dft);
  RETURN app.rpt_tx_result(v_ids, f, v_sort, v_limit, v_offset, true) || jsonb_build_object('totals', v_tot, 'generated_at', now());
END $$;

-- 5.1 report_trips (20261106000100, re-created). RPT: + driver_id / driver_q / party_type / party_q / q (legacy transport report
-- filters), party_type / party_name on the rows, totals.by_carrier [{party_type, party_name, carrier_id, trips,
-- value_by_currency}] and totals.by_driver [{driver_id, driver_name, trips, value_by_currency}] (trips desc; the values = Σ exactly
-- the cost amounts the rows show, so only with include_finance and the finance role at the row's branch).
CREATE OR REPLACE FUNCTION public.report_trips(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_cl uuid; v_car uuid; v_st text[]; v_rng date[]; v_from date; v_to date;
  v_fin boolean; v_sort text; v_limit int; v_offset int; v_ids uuid[]; v_total int; v_fp text; v_items jsonb; v_by jsonb;
  v_cost jsonb; v_sell jsonb; v_nfin int; v_late boolean; v_tf timestamptz; v_tt timestamptz; v_sc uuid[]; v_tsc uuid[];
  v_drv uuid; v_drq text; v_pt text[]; v_ptq text; v_q text; v_qp text; v_qn text; v_qc text; v_byc jsonb; v_byd jsonb;  -- RPT
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_trip_keys());
  v_br := app.rpt_branch(p_org, f);
  v_cl := app.puuid(f, 'client_id');
  v_car := app.puuid(f, 'carrier_id');
  v_st := app.rpt_codes(f, 'status', 'trip_status', 'trip_status');
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  -- late = planned / dispatched with planned_at already past (the dash_ops 'late' tile)
  IF jsonb_typeof(f -> 'late') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'late'); END IF;
  v_late := app.pbool(f, 'late');
  IF jsonb_typeof(f -> 'include_finance') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'include_finance'); END IF;
  v_fin := app.pbool(f, 'include_finance');
  IF v_fin AND NOT app.has_role(p_org, app.trip_finance_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'cost'); END IF;
  v_sort := coalesce(app.ptext(f, 'sort', 30), 'planned_desc');
  IF v_sort NOT IN ('planned_desc','planned_asc') THEN PERFORM app.fail('MRS_INVALID', 'sort'); END IF;
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  -- RPT
  v_drv := app.puuid(f, 'driver_id');
  v_drq := app.rpt_like(app.ptext(f, 'driver_q', 80));
  v_pt := app.rpt_codes(f, 'party_type', 'transport_party_type');
  v_ptq := app.rpt_like(app.ptext(f, 'party_q', 80));
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(app.to_western(v_q)); v_qn := app.rpt_like(app.rpt_norm_no(v_q)); v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  v_tsc := CASE WHEN v_fin THEN app.rpt_scope(p_org, app.trip_finance_roles()) ELSE '{}'::uuid[] END;
  SELECT array_agg(tr.id) INTO v_ids
    FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
    JOIN public.clients cl ON cl.id = t.client_id
    LEFT JOIN public.parties pa ON pa.id = tr.carrier_id
    LEFT JOIN public.drivers d ON d.id = tr.driver_id
    LEFT JOIN public.trucks k ON k.id = tr.truck_id
    LEFT JOIN public.containers c ON c.id = tr.container_id
   WHERE t.org_id = p_org AND tr.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_car IS NULL OR tr.carrier_id = v_car)
     AND (v_st IS NULL OR tr.status = ANY (v_st))
     AND (NOT v_late OR (tr.status IN ('planned','dispatched') AND tr.planned_at < now()))
     AND (v_tf IS NULL OR tr.planned_at >= v_tf) AND (v_tt IS NULL OR tr.planned_at < v_tt)
     -- RPT
     AND (v_drv IS NULL OR tr.driver_id = v_drv)
     AND (v_drq IS NULL OR d.full_name ILIKE v_drq)
     AND (v_pt IS NULL OR tr.party_type = ANY (v_pt))
     AND (v_ptq IS NULL OR tr.party_name ILIKE v_ptq OR pa.name_ar ILIKE v_ptq OR pa.name_en ILIKE v_ptq)
     AND (v_q IS NULL OR t.ref ILIKE v_qn OR cl.name_ar ILIKE v_qp OR cl.name_en ILIKE v_qp OR t.declaration_no ILIKE v_qn
          OR c.container_no ILIKE v_qc OR tr.party_name ILIKE v_qp OR pa.name_ar ILIKE v_qp OR d.full_name ILIKE v_qp
          OR k.plate_no ILIKE v_qn OR tr.transport_order_no ILIKE v_qn OR t.transport_order_no ILIKE v_qn
          OR EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.id = tr.appointment_id AND a.appointment_no ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.customs_declarations x WHERE x.transaction_id = t.id AND x.declaration_no ILIKE v_qn));
  v_ids := coalesce(v_ids, '{}'::uuid[]);
  SELECT count(*)::int, md5(coalesce(string_agg(tr.id::text || ':' || coalesce(tr.updated_at::text, ''), ',' ORDER BY tr.id), ''))
    INTO v_total, v_fp FROM public.transport_trips tr WHERE tr.id = ANY (v_ids);
  SELECT coalesce(jsonb_object_agg(x.s, x.n), '{}'::jsonb) INTO v_by
    FROM (SELECT tr.status s, count(*)::int n FROM public.transport_trips tr WHERE tr.id = ANY (v_ids) GROUP BY 1) x;
  -- finance totals = Σ exactly the non-null values the rows carry
  WITH r AS (SELECT tr.* FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
              WHERE tr.id = ANY (v_ids) AND v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc)))
  SELECT (SELECT count(*)::int FROM r),
         (SELECT coalesce(jsonb_object_agg(x.c, x.s), '{}'::jsonb)
            FROM (SELECT r.cost_currency c, round(sum(r.cost_amount), 2) s FROM r WHERE r.cost_amount IS NOT NULL GROUP BY 1) x),
         (SELECT coalesce(jsonb_object_agg(x.c, x.s), '{}'::jsonb)
            FROM (SELECT r.sell_currency c, round(sum(r.sell_amount), 2) s FROM r WHERE r.sell_amount IS NOT NULL GROUP BY 1) x)
    INTO v_nfin, v_cost, v_sell;
  -- RPT: groups by transport party and by driver (legacy byParty / byDriver)
  WITH g AS (
    SELECT tr.id, coalesce(tr.party_type, CASE WHEN tr.carrier_id IS NOT NULL THEN 'company' END) pt,
           coalesce(nullif(btrim(tr.party_name), ''), pa.name_ar) pn, tr.carrier_id, tr.driver_id, d.full_name dn,
           CASE WHEN v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc)) THEN tr.cost_amount END amt, tr.cost_currency cur
      FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
      LEFT JOIN public.parties pa ON pa.id = tr.carrier_id LEFT JOIN public.drivers d ON d.id = tr.driver_id
     WHERE tr.id = ANY (v_ids)),
  gc AS (SELECT g.pt, g.pn, min(g.carrier_id::text)::uuid car, count(*)::int n,
                (SELECT coalesce(jsonb_object_agg(z.cur, z.s), '{}'::jsonb)
                   FROM (SELECT g2.cur, round(sum(g2.amt), 2) s FROM g g2
                          WHERE g2.pt IS NOT DISTINCT FROM g.pt AND g2.pn IS NOT DISTINCT FROM g.pn AND g2.amt IS NOT NULL GROUP BY 1) z) v
           FROM g GROUP BY g.pt, g.pn),
  gd AS (SELECT g.driver_id, max(g.dn) dn, count(*)::int n,
                (SELECT coalesce(jsonb_object_agg(z.cur, z.s), '{}'::jsonb)
                   FROM (SELECT g2.cur, round(sum(g2.amt), 2) s FROM g g2
                          WHERE g2.driver_id IS NOT DISTINCT FROM g.driver_id AND g2.amt IS NOT NULL GROUP BY 1) z) v
           FROM g GROUP BY g.driver_id)
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('party_type', gc.pt, 'party_name', gc.pn, 'carrier_id', gc.car, 'trips', gc.n,
                   'value_by_currency', gc.v) ORDER BY gc.n DESC, gc.pn NULLS LAST, gc.pt NULLS LAST), '[]'::jsonb)
            FROM (SELECT * FROM gc ORDER BY gc.n DESC, gc.pn NULLS LAST LIMIT 200) gc),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('driver_id', gd.driver_id, 'driver_name', gd.dn, 'trips', gd.n,
                   'value_by_currency', gd.v) ORDER BY gd.n DESC, gd.dn NULLS LAST), '[]'::jsonb)
            FROM (SELECT * FROM gd ORDER BY gd.n DESC, gd.dn NULLS LAST LIMIT 200) gd)
    INTO v_byc, v_byd;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'transaction_id', p.transaction_id, 'transaction_ref', p.ref,
           'container_no', p.container_no, 'leg_no', p.leg_no, 'carrier_name', p.carrier_name, 'driver_name', p.driver_name,
           'truck_plate', p.truck_plate, 'origin', p.origin, 'destination', p.destination, 'planned_at', p.planned_at,
           'loaded_at', p.loaded_at, 'unloaded_at', p.unloaded_at, 'status', p.status,
           'cost_amount', CASE WHEN p.fin THEN round(p.cost_amount, 2) END, 'cost_currency', CASE WHEN p.fin THEN p.cost_currency END,
           'sell_amount', CASE WHEN p.fin THEN round(p.sell_amount, 2) END, 'sell_currency', CASE WHEN p.fin THEN p.sell_currency END,
           'driver_id', p.driver_id, 'driver_phone', p.driver_phone, 'party_type', p.party_type,                    -- RPT
           'party_name', coalesce(nullif(btrim(p.party_name), ''), p.carrier_name), 'transport_order_no', p.transport_order_no,
           'client_name', p.client_name, 'appointment_no', p.appointment_no, 'appointment_at', p.appointment_at)
           ORDER BY p.o), '[]'::jsonb)
    INTO v_items
    FROM (SELECT tr.*, t.ref, c.container_no, pa.name_ar carrier_name, d.full_name driver_name, d.phone driver_phone, k.plate_no truck_plate,
                 cl.name_ar client_name, ap.appointment_no, ap.appointment_at,
                 (v_fin AND (v_tsc IS NULL OR t.branch_id = ANY (v_tsc))) fin,
                 row_number() OVER (ORDER BY
                   CASE WHEN v_sort = 'planned_desc' THEN tr.planned_at END DESC NULLS LAST,
                   CASE WHEN v_sort = 'planned_asc' THEN tr.planned_at END ASC NULLS LAST,
                   tr.id) o
            FROM public.transport_trips tr JOIN public.transactions t ON t.id = tr.transaction_id
            JOIN public.clients cl ON cl.id = t.client_id
            LEFT JOIN public.containers c ON c.id = tr.container_id
            LEFT JOIN public.parties pa ON pa.id = tr.carrier_id
            LEFT JOIN public.drivers d ON d.id = tr.driver_id
            LEFT JOIN public.trucks k ON k.id = tr.truck_id
            LEFT JOIN public.port_appointments ap ON ap.id = tr.appointment_id
           WHERE tr.id = ANY (v_ids)) p
   WHERE p.o > v_offset AND p.o <= v_offset + v_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'fingerprint', v_fp,
    'include_finance', v_fin, 'late', v_late,
    'totals', jsonb_build_object('count', v_total, 'by_status', v_by,
      'finance', jsonb_build_object('cost_by_currency', v_cost, 'sell_by_currency', v_sell, 'rows_with_finance', v_nfin),
      'by_carrier', v_byc, 'by_driver', v_byd));                                                                      -- RPT
END $$;

-- 5.4 log_report_export (20261106000100, re-created). RPT: the step-8 reports and their gates — payments: fin_read in the org
-- ('finance'); movements with a value / revenue range: trip finance in the org ('cost'); tx_followup / fasah_recon: staff.
CREATE OR REPLACE FUNCTION public.log_report_export(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_report text; v_format text; v_f jsonb; v_rows numeric; k text; v jsonb;
  v_id uuid; v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['report','format','filters','row_count']);
  IF jsonb_typeof(p -> 'report') IS DISTINCT FROM 'string' OR NOT app.is_code('report_kind', p ->> 'report') THEN
    PERFORM app.fail('MRS_INVALID', 'report');
  END IF;
  IF jsonb_typeof(p -> 'format') IS DISTINCT FROM 'string' OR NOT app.is_code('export_format', p ->> 'format') THEN
    PERFORM app.fail('MRS_INVALID', 'format');
  END IF;
  v_report := p ->> 'report'; v_format := p ->> 'format';
  v_f := coalesce(nullif(p -> 'filters', 'null'::jsonb), '{}'::jsonb);
  -- the report's own gate
  PERFORM app.rpt_gate_staff(p_org);
  IF v_report IN ('margins','costs','payments') THEN PERFORM app.fin_org_read(p_org); END IF;                       -- RPT payments
  IF jsonb_typeof(v_f) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'filters'); END IF;
  IF v_report = 'trips' AND lower(coalesce(v_f ->> 'include_finance', '')) IN ('true','1','on','yes')
     AND NOT app.has_role(p_org, app.trip_finance_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'cost');
  END IF;
  IF v_report = 'movements' AND v_f ?| ARRAY['value_min','value_max','revenue_min','revenue_max']                     -- RPT
     AND NOT app.has_role(p_org, app.trip_finance_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'cost');
  END IF;
  -- filters: keys of the report, scalar values / arrays of codes, text ≤ 80
  IF octet_length(v_f::text) > 4096 THEN PERFORM app.fail('MRS_TOO_LONG', 'filters'); END IF;
  FOR k, v IN SELECT * FROM jsonb_each(v_f) LOOP
    IF NOT (k = ANY (app.rpt_export_keys(v_report))) THEN PERFORM app.fail('MRS_INVALID', 'filters'); END IF;
    IF jsonb_typeof(v) = 'object' THEN PERFORM app.fail('MRS_INVALID', 'filters'); END IF;
    IF jsonb_typeof(v) = 'string' AND char_length(v #>> '{}') > 80 THEN PERFORM app.fail('MRS_TOO_LONG', 'filters'); END IF;
    IF jsonb_typeof(v) = 'array' THEN
      -- ≤ 20 values; a Fasah reconciliation's months / ports follow its ≤ 100 port-month scopes (report_fasah_scope)
      IF jsonb_array_length(v) > (CASE WHEN v_report = 'fasah_recon' AND k IN ('months','port_codes') THEN 100 ELSE 20 END)
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
        PERFORM app.fail('MRS_INVALID', 'filters');
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v) e WHERE char_length(e) > 80) THEN PERFORM app.fail('MRS_TOO_LONG', 'filters'); END IF;
    END IF;
  END LOOP;
  -- row count (G6a-8 caps)
  IF jsonb_typeof(p -> 'row_count') IS DISTINCT FROM 'number' THEN PERFORM app.fail('MRS_INVALID', 'export_rows'); END IF;
  v_rows := (p ->> 'row_count')::numeric;
  IF v_rows <> trunc(v_rows) OR v_rows < 0 OR v_rows > 10000 OR (v_format = 'print' AND v_rows > 2000) THEN
    PERFORM app.fail('MRS_INVALID', 'export_rows');
  END IF;
  INSERT INTO public.report_exports (org_id, actor, report, format, filters, row_count)
  VALUES (p_org, auth.uid(), v_report, v_format, v_f, v_rows::int)
  RETURNING id, created_at INTO v_id, v_at;
  RETURN jsonb_build_object('id', v_id, 'created_at', v_at);
END $$;

-- alert causes (20261117000100, re-created): body identical except (RPT) the two legacy attention kinds, from app.att_reasons with
-- the org's aging rules: status_stale (one per transaction and effective status; severity escalates warning → critical; a newer
-- update or a status change resolves it) and appointment_not_updated (one per appointment). The overdue empty return is already
-- the critical empty_return_overdue alert.
CREATE OR REPLACE FUNCTION app.alert_causes(p_org uuid, p_now timestamptz)
RETURNS TABLE (dedupe_key text, kind text, severity text, branch_id uuid, transaction_id uuid, container_id uuid,
               subject_id uuid, title_ar text, title_en text, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH today AS (SELECT (p_now AT TIME ZONE 'Asia/Riyadh')::date AS d),
  active_tx AS (
    SELECT t.* FROM public.transactions t
     WHERE t.org_id = p_org AND t.cancelled_at IS NULL
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
     GROUP BY t.id, t.branch_id, t.ref, nx.code, nx.label_ar, nx.label_en),
  att AS (SELECT x.* FROM app.att_reasons(p_org, NULL, p_now) x WHERE x.reason IN ('status_stale','appointment_not_updated'))  -- RPT
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
   WHERE a.org_id = p_org AND a.status IN ('requested','confirmed') AND t.cancelled_at IS NULL
     AND a.appointment_at > p_now AND a.appointment_at <= p_now + interval '24 hours'
  UNION ALL
  -- window over without an outcome, or marked missed and not rescheduled / cancelled yet
  SELECT 'appointment_missed:' || a.id, 'appointment_missed', 'critical', t.branch_id, t.id, a.container_id, a.id,
         'موعد فائت يحتاج إعادة جدولة — ' || t.ref, 'Missed appointment needs a new slot — ' || t.ref, a.appointment_at
    FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.org_id = p_org AND t.cancelled_at IS NULL
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
   WHERE c.org_id = p_org AND c.return_status IN ('pending','evidence_submitted','disputed') AND t.cancelled_at IS NULL
     AND c.return_deadline IS NOT NULL AND c.return_deadline <= today.d + 3
  UNION ALL
  SELECT 'exception_open:' || e.id, 'exception_open', CASE WHEN e.kind = 'customs_rejection' THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, e.container_id, e.id,
         'استثناء مفتوح: ' || coalesce(l.label_ar, e.kind) || ' — ' || t.ref,
         'Open exception: ' || coalesce(l.label_en, e.kind) || ' — ' || t.ref, NULL::timestamptz
    FROM public.operational_exceptions e JOIN public.transactions t ON t.id = e.transaction_id
    LEFT JOIN public.status_labels l ON l.domain = 'exception_kind' AND l.code = e.kind
   WHERE e.org_id = p_org AND e.status IN ('open','in_progress') AND t.cancelled_at IS NULL
  UNION ALL
  -- an active declaration with no status change for 3 days on an open transaction
  SELECT 'declaration_stalled:' || d.id || ':' || d.status, 'declaration_stalled', 'warning', t.branch_id, t.id, NULL::uuid, d.id,
         'بيان جمركي ' || d.declaration_no || ' بلا تحديث منذ 3 أيام — ' || t.ref,
         'Declaration ' || d.declaration_no || ' not updated for 3 days — ' || t.ref, d.updated_at + interval '3 days'
    FROM public.customs_declarations d JOIN active_tx t ON t.id = d.transaction_id
   WHERE d.status IN ('draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',
                      'release_ready') AND d.updated_at < p_now - interval '3 days'
  UNION ALL
  -- RPT: no update for longer than the aging rule of the (effective) status
  SELECT 'status_stale:' || x.transaction_id || ':' || x.effective_status, 'status_stale', x.level, x.branch_id, x.transaction_id,
         NULL::uuid, x.transaction_id,
         'معاملة بلا تحديث في حالة «' || coalesce(l.label_ar, x.effective_status) || '» أكثر من '
           || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END || ' ساعة — ' || x.ref,
         'Transaction not updated in "' || coalesce(l.label_en, x.effective_status) || '" for more than '
           || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END || ' h — ' || x.ref,
         x.since + make_interval(hours => x.critical_hours)
    FROM att x LEFT JOIN public.status_labels l ON l.domain = 'operational_status' AND l.code = x.effective_status
   WHERE x.reason = 'status_stale'
  UNION ALL
  -- RPT: the gate-out appointment passed and the movement was not updated
  SELECT 'appointment_not_updated:' || x.subject_id, 'appointment_not_updated', x.level, x.branch_id, x.transaction_id,
         x.container_id, x.subject_id,
         'موعد الخروج مضى عليه أكثر من ' || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END
           || ' ساعة دون تحديث الحركة — ' || x.ref || coalesce(' — ' || x.container_no, ''),
         'Gate-out appointment passed more than ' || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END
           || ' h ago without a movement update — ' || x.ref || coalesce(' — ' || x.container_no, ''),
         x.since + make_interval(hours => x.critical_hours)
    FROM att x WHERE x.reason = 'appointment_not_updated'
$$;

-- ---------------------------------------------------------------------
-- 3. RPCs (authenticated; each checks its own gate)
-- ---------------------------------------------------------------------

-- dash_tx_counts(p_org, {branch_id}) — legacy fastBuildDashboardStats_ / renderDashboardStats: counts that equal the lists the tiles
-- open (#transactions?status= → report_transactions {operational_status}; ?stage= → {declaration_status}; drafts → the pending
-- document / appointment drafts; appointments today / transported containers → report_movements). Staff, branch-scoped, no money.
--   → {total, open, cancelled, by_status {code: n} (every operational status, 0 included), declaration_stages {accepted,
--      cco_review_done, awaiting_duty_payment, release_ready, released}, by_declaration_status {code: n}, no_declaration,
--      drafts {documents, appointments}, appointments_today, transported_containers, attention {critical, warning, total},
--      daftra {none, draft, issued, cancelled_review} | null (finance readers only: their fin_read scope), today, branch_id,
--      generated_at}
CREATE OR REPLACE FUNCTION public.dash_tx_counts(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_sc uuid[]; v_fsc uuid[]; v_tx uuid[]; v_today date := app.rpt_today();
  v_by jsonb; v_ds jsonb; v_res jsonb; v_att jsonb; v_dft jsonb; v_mv jsonb; v_drafts jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, ARRAY['branch_id']);
  v_br := app.rpt_branch(p_org, f);
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  SELECT coalesce(array_agg(t.id), '{}'::uuid[]) INTO v_tx FROM public.transactions t
   WHERE t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND (v_br IS NULL OR t.branch_id = v_br);
  SELECT jsonb_object_agg(l.code, coalesce(x.n, 0) ORDER BY l.sort) INTO v_by
    FROM public.status_labels l
    LEFT JOIN (SELECT t.operational_status s, count(*)::int n FROM public.transactions t WHERE t.id = ANY (v_tx) GROUP BY 1) x ON x.s = l.code
   WHERE l.domain = 'operational_status';
  SELECT jsonb_object_agg(l.code, coalesce(x.n, 0) ORDER BY l.sort) INTO v_ds
    FROM public.status_labels l
    LEFT JOIN (SELECT app.rpt_decl_status(t.id) s, count(*)::int n FROM public.transactions t WHERE t.id = ANY (v_tx) GROUP BY 1) x ON x.s = l.code
   WHERE l.domain = 'declaration_status';
  SELECT jsonb_build_object(
           'documents', (SELECT count(*)::int FROM public.doc_batches b
                          WHERE b.org_id = p_org AND b.status = 'draft'
                            AND (b.transaction_id = ANY (v_tx)
                                 OR (b.transaction_id IS NULL AND (v_sc IS NULL OR b.branch_id = ANY (v_sc)) AND (v_br IS NULL OR b.branch_id = v_br)))),
           'appointments', (SELECT count(*)::int FROM public.appointment_drafts d
                             WHERE d.org_id = p_org AND d.status IN ('pending','partial') AND d.transaction_id = ANY (v_tx)))
    INTO v_drafts;
  SELECT jsonb_build_object(
           'appointments_today', count(*) FILTER (WHERE m.appointment_id IS NOT NULL AND app.rpt_day(m.appointment_at) = v_today),
           'transported_containers', count(DISTINCT coalesce(m.container_id::text, 'tx:' || m.transaction_id::text))
                                       FILTER (WHERE m.movement_status = 'delivered'))
    INTO v_mv
    FROM app.rpt_mv(p_org) m WHERE m.transaction_id = ANY (v_tx);
  SELECT jsonb_build_object('critical', count(*) FILTER (WHERE g.crit)::int, 'warning', count(*) FILTER (WHERE NOT g.crit)::int,
                            'total', count(*)::int)
    INTO v_att
    FROM (SELECT x.transaction_id, bool_or(x.level = 'critical') crit FROM app.att_reasons(p_org, v_tx, now()) x GROUP BY 1) g;
  IF app.has_role(p_org, app.fin_read_roles()) THEN
    v_fsc := app.rpt_scope(p_org, app.fin_read_roles());
    SELECT jsonb_object_agg(l.code, coalesce(x.n, 0) ORDER BY l.sort) INTO v_dft
      FROM public.status_labels l
      LEFT JOIN (SELECT app.rpt_daftra_state(t.id) s, count(*)::int n FROM public.transactions t
                  WHERE t.id = ANY (v_tx) AND (v_fsc IS NULL OR t.branch_id = ANY (v_fsc)) GROUP BY 1) x ON x.s = l.code
     WHERE l.domain = 'tx_daftra_state';
  END IF;
  SELECT jsonb_build_object('total', cardinality(v_tx),
           'open', (SELECT count(*)::int FROM public.transactions t WHERE t.id = ANY (v_tx) AND t.cancelled_at IS NULL
                      AND t.operational_status = ANY (app.rpt_open_tx())),
           'cancelled', (SELECT count(*)::int FROM public.transactions t WHERE t.id = ANY (v_tx) AND t.cancelled_at IS NOT NULL),
           'by_status', v_by, 'by_declaration_status', v_ds,
           'declaration_stages', jsonb_build_object('accepted', v_ds -> 'accepted', 'cco_review_done', v_ds -> 'cco_review_done',
                                   'awaiting_duty_payment', v_ds -> 'awaiting_duty_payment', 'release_ready', v_ds -> 'release_ready',
                                   'released', v_ds -> 'released'),
           'no_declaration', (SELECT count(*)::int FROM public.transactions t WHERE t.id = ANY (v_tx)
                                AND NOT EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id)),
           'drafts', v_drafts, 'appointments_today', (v_mv ->> 'appointments_today')::int,
           'transported_containers', (v_mv ->> 'transported_containers')::int, 'attention', v_att, 'daftra', v_dft,
           'today', v_today, 'branch_id', v_br, 'generated_at', now())
    INTO v_res;
  RETURN v_res;
END $$;

-- tx_attention(p_org, filters of report_transactions) — the attention banner / «المتأخرة فقط» / follow-up export: every
-- transaction of the SAME filtered set (app.rpt_tx_match) that needs attention now, with its reasons.
--   → {items [{transaction_id, ref, level, hours, reasons [...]}] (critical first, then the oldest; ≤ 2000), total, truncated,
--      totals {critical, warning, by_reason {code: n}}, rules (the org's effective aging rules), generated_at}
CREATE OR REPLACE FUNCTION public.tx_attention(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_ids uuid[]; v_now timestamptz := now(); v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_search_keys());
  PERFORM app.rpt_tx_sort(f);
  PERFORM app.rpt_limit(f, 500, 100);
  PERFORM app.rpt_offset(f);
  SELECT array_agg(m) INTO v_ids FROM app.rpt_tx_match(p_org, f) m;
  WITH r AS (SELECT * FROM app.att_reasons(p_org, coalesce(v_ids, '{}'::uuid[]), v_now)),
  g AS (SELECT r.transaction_id, max(r.ref) ref, CASE WHEN bool_or(r.level = 'critical') THEN 'critical' ELSE 'warning' END lvl,
               max(r.hours) hrs,
               jsonb_agg(jsonb_build_object('code', r.reason, 'level', r.level, 'hours', r.hours, 'since', r.since,
                 'subject_id', r.subject_id, 'container_id', r.container_id, 'container_no', r.container_no,
                 'status', r.effective_status, 'warning_hours', r.warning_hours, 'critical_hours', r.critical_hours)
                 ORDER BY (r.level = 'critical') DESC, r.hours DESC, r.reason, r.subject_id) reasons
          FROM r GROUP BY r.transaction_id)
  SELECT jsonb_build_object(
           'items', coalesce((SELECT jsonb_agg(jsonb_build_object('transaction_id', p.transaction_id, 'ref', p.ref, 'level', p.lvl,
                       'hours', p.hrs, 'reasons', p.reasons) ORDER BY (p.lvl = 'critical') DESC, p.hrs DESC, p.transaction_id)
                       FROM (SELECT * FROM g ORDER BY (g.lvl = 'critical') DESC, g.hrs DESC, g.transaction_id LIMIT 2000) p), '[]'::jsonb),
           'total', (SELECT count(*)::int FROM g),
           'truncated', (SELECT count(*) > 2000 FROM g),
           'totals', jsonb_build_object('critical', (SELECT count(*)::int FROM g WHERE g.lvl = 'critical'),
                                        'warning', (SELECT count(*)::int FROM g WHERE g.lvl = 'warning'),
                                        'by_reason', coalesce((SELECT jsonb_object_agg(z.reason, z.n)
                                                                 FROM (SELECT r.reason, count(DISTINCT r.transaction_id)::int n FROM r GROUP BY 1) z), '{}'::jsonb)),
           'rules', app.status_aging_rules(p_org), 'generated_at', v_now)
    INTO v_res;
  RETURN v_res;
END $$;

-- report_movements(p_org, filters) — legacy fastBuildMovementDashboard_ / applyMovementFilters_ / buildMovementsExportSheet_:
-- appointments and transport, one row per movement (app.rpt_mv). Staff, branch-scoped through the transaction. Transport value
-- (cost_amount) / organisation revenue (sell_amount) only with trip finance at the row's branch (else null); the value / revenue
-- ranges need trip finance in the org (MRS_FORBIDDEN 'cost') and match only rows whose amounts the caller may see.
--   keys: app.rpt_mv_keys() — date_field appointment (default) | return_deadline | returned | delivered | created | updated;
--         from / to (Riyadh days); return_scope overdue | pending | returned; movement_status / return_status / party_type: codes;
--         port_code: customs port codes; sort appointment_desc (default) | appointment_asc | deadline_asc | updated_desc;
--         limit ≤ 500 (100), offset
--   → {items [...], total, limit, offset, fingerprint, finance (the caller has trip finance somewhere), today,
--      totals {count, appointments, cancelled, delivered_containers, overdue_returns, by_movement_status, transport_value
--      {CUR: Σ}, revenue {CUR: Σ}, rows_with_finance}} — the money totals cover the non-cancelled rows with visible amounts.
CREATE OR REPLACE FUNCTION public.report_movements(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_tx uuid; v_cl uuid; v_clq text; v_drv uuid; v_drq text; v_trq text;
  v_car uuid; v_pt text[]; v_ptq text; v_ms text[]; v_bl text; v_decl text; v_cno text; v_ports text[]; v_rs text[]; v_scope text;
  v_dest text; v_book text; v_opq text; v_emp uuid; v_df text; v_rng date[]; v_from date; v_to date; v_tf timestamptz; v_tt timestamptz;
  v_val numeric[]; v_rev numeric[]; v_q text; v_qp text; v_qn text; v_qc text; v_sort text; v_limit int; v_offset int;
  v_sc uuid[]; v_tsc uuid[]; v_anyfin boolean; v_today date := app.rpt_today(); v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  PERFORM app.only_keys(f, app.rpt_mv_keys());
  v_br := app.rpt_branch(p_org, f);
  v_tx := app.puuid(f, 'transaction_id');
  v_cl := app.puuid(f, 'client_id');
  v_clq := app.rpt_like(app.to_western(app.ptext(f, 'client_q', 80)));
  v_drv := app.puuid(f, 'driver_id');
  v_drq := app.rpt_like(app.to_western(app.ptext(f, 'driver_q', 80)));
  v_trq := app.rpt_like(app.norm_code(replace(translate(coalesce(app.ptext(f, 'truck_q', 30), ''), 'أإآ', 'ااا'), '-', '')));
  v_car := app.puuid(f, 'carrier_id');
  v_pt := app.rpt_codes(f, 'party_type', 'transport_party_type');
  v_ptq := app.rpt_like(app.ptext(f, 'party_q', 80));
  v_ms := app.rpt_codes(f, 'movement_status', 'movement_status');
  v_bl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'bl_number', 80)));
  v_decl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'declaration_no', 80)));
  v_cno := app.rpt_like(app.rpt_norm_container(app.ptext(f, 'container_no', 80)));
  v_ports := app.rpt_ports(f, 'port_code');
  v_rs := app.rpt_codes(f, 'return_status', 'container_return_status', 'return_status');
  v_scope := app.ptext(f, 'return_scope', 20);
  IF v_scope IS NOT NULL AND NOT app.is_code('return_scope', v_scope) THEN PERFORM app.fail('MRS_INVALID', 'return_scope'); END IF;
  v_dest := app.rpt_like(app.ptext(f, 'destination_q', 80));
  v_book := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'booking_q', 80)));
  v_opq := app.rpt_like(app.ptext(f, 'operator_q', 80));
  v_emp := app.puuid(f, 'employee_id');
  v_df := coalesce(app.ptext(f, 'date_field', 20), 'appointment');
  IF NOT app.is_code('movement_date_field', v_df) THEN PERFORM app.fail('MRS_INVALID', 'date_field'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_val := app.rpt_num_range(f, 'value_min', 'value_max', 'value_range', 100000000);
  v_rev := app.rpt_num_range(f, 'revenue_min', 'revenue_max', 'revenue_range', 100000000);
  v_anyfin := app.has_role(p_org, app.trip_finance_roles());
  IF (v_val[1] IS NOT NULL OR v_val[2] IS NOT NULL OR v_rev[1] IS NOT NULL OR v_rev[2] IS NOT NULL) AND NOT v_anyfin THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'cost');
  END IF;
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(app.to_western(v_q)); v_qn := app.rpt_like(app.rpt_norm_no(v_q)); v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_sort := coalesce(app.ptext(f, 'sort', 30), 'appointment_desc');
  IF v_sort NOT IN ('appointment_desc','appointment_asc','deadline_asc','updated_desc') THEN PERFORM app.fail('MRS_INVALID', 'sort'); END IF;
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  v_tsc := CASE WHEN v_anyfin THEN app.rpt_scope(p_org, app.trip_finance_roles()) ELSE '{}'::uuid[] END;

  WITH base AS (
    SELECT m.*, (v_anyfin AND (v_tsc IS NULL OR m.branch_id = ANY (v_tsc))) fin,
           -- legacy applyMovementFilters_: an actual return date makes the row «returned», never «overdue» (disjoint scopes)
           (m.returned_at IS NULL AND m.return_status = ANY (app.rpt_open_returns()) AND m.return_deadline IS NOT NULL
            AND m.return_deadline < v_today) overdue,
           (m.returned_at IS NOT NULL OR m.return_status = 'returned_verified') returned,
           pr.full_name employee_name
      FROM app.rpt_mv(p_org) m LEFT JOIN public.profiles pr ON pr.id = m.created_by
     WHERE (v_sc IS NULL OR m.branch_id = ANY (v_sc))),
  s AS (
    SELECT b.* FROM base b
     WHERE (v_br IS NULL OR b.branch_id = v_br)
       AND (v_tx IS NULL OR b.transaction_id = v_tx)
       AND (v_cl IS NULL OR b.client_id = v_cl)
       AND (v_clq IS NULL OR b.client_name ILIKE v_clq
            OR EXISTS (SELECT 1 FROM public.clients c WHERE c.id = b.client_id AND (c.name_en ILIKE v_clq OR c.cr_number ILIKE v_clq)))
       AND (v_drv IS NULL OR b.driver_id = v_drv)
       AND (v_drq IS NULL OR b.driver_name ILIKE v_drq OR b.driver_phone ILIKE v_drq)
       AND (v_trq IS NULL OR b.truck_plate ILIKE v_trq)
       AND (v_car IS NULL OR b.carrier_id = v_car)
       AND (v_pt IS NULL OR b.party_type = ANY (v_pt))
       AND (v_ptq IS NULL OR b.party_name ILIKE v_ptq)
       AND (v_ms IS NULL OR b.movement_status = ANY (v_ms))
       AND (v_bl IS NULL OR b.bl_number ILIKE v_bl)
       AND (v_decl IS NULL OR b.declaration_no ILIKE v_decl)
       AND (v_cno IS NULL OR b.container_no ILIKE v_cno)
       AND (v_ports IS NULL OR b.port_code = ANY (v_ports))
       AND (v_rs IS NULL OR b.return_status = ANY (v_rs))
       AND (v_scope IS NULL OR (v_scope = 'overdue' AND b.overdue) OR (v_scope = 'pending' AND NOT b.returned AND b.container_id IS NOT NULL
                                 AND b.return_status IS DISTINCT FROM 'waived')
            OR (v_scope = 'returned' AND b.returned))
       AND (v_dest IS NULL OR b.destination ILIKE v_dest)
       AND (v_book IS NULL OR b.appointment_no ILIKE v_book OR b.booking_ref ILIKE v_book)
       AND (v_opq IS NULL OR b.operator_name ILIKE v_opq)
       AND (v_emp IS NULL OR b.created_by = v_emp)
       AND (v_val[1] IS NULL OR (b.fin AND b.cost_amount >= v_val[1]))
       AND (v_val[2] IS NULL OR (b.fin AND b.cost_amount <= v_val[2]))
       AND (v_rev[1] IS NULL OR (b.fin AND b.sell_amount >= v_rev[1]))
       AND (v_rev[2] IS NULL OR (b.fin AND b.sell_amount <= v_rev[2]))
       AND (v_q IS NULL OR b.driver_name ILIKE v_qp OR b.driver_phone ILIKE v_qp OR b.truck_plate ILIKE v_qn OR b.container_no ILIKE v_qc
            OR b.declaration_no ILIKE v_qn OR b.client_name ILIKE v_qp OR b.bl_number ILIKE v_qn OR b.port_name ILIKE v_qp
            OR b.port_code ILIKE v_qn OR b.destination ILIKE v_qp OR b.return_location ILIKE v_qp OR b.appointment_no ILIKE v_qn
            OR b.booking_ref ILIKE v_qn OR b.operator_name ILIKE v_qp OR b.party_name ILIKE v_qp OR b.transport_order_no ILIKE v_qn
            OR b.ref ILIKE v_qn OR b.employee_name ILIKE v_qp)
       AND (v_df <> 'appointment' OR ((v_tf IS NULL OR b.appointment_at >= v_tf) AND (v_tt IS NULL OR b.appointment_at < v_tt)))
       AND (v_df <> 'return_deadline' OR ((v_from IS NULL OR b.return_deadline >= v_from) AND (v_to IS NULL OR b.return_deadline <= v_to)))
       AND (v_df <> 'returned' OR ((v_tf IS NULL OR b.returned_at >= v_tf) AND (v_tt IS NULL OR b.returned_at < v_tt)))
       AND (v_df <> 'delivered' OR ((v_tf IS NULL OR b.delivered_at >= v_tf) AND (v_tt IS NULL OR b.delivered_at < v_tt)))
       AND (v_df <> 'created' OR ((v_tf IS NULL OR b.created_at >= v_tf) AND (v_tt IS NULL OR b.created_at < v_tt)))
       AND (v_df <> 'updated' OR ((v_tf IS NULL OR b.updated_at >= v_tf) AND (v_tt IS NULL OR b.updated_at < v_tt)))),
  o AS (
    SELECT s.*, row_number() OVER (ORDER BY
             CASE WHEN v_sort = 'appointment_desc' THEN s.appointment_at END DESC NULLS LAST,
             CASE WHEN v_sort = 'appointment_asc' THEN s.appointment_at END ASC NULLS LAST,
             CASE WHEN v_sort = 'deadline_asc' THEN s.return_deadline END ASC NULLS LAST,
             CASE WHEN v_sort = 'updated_desc' THEN s.updated_at END DESC NULLS LAST,
             s.updated_at DESC NULLS LAST, s.id) rn
      FROM s)
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'kind', o.kind, 'appointment_id', o.appointment_id, 'trip_id', o.trip_id, 'transaction_id', o.transaction_id,
        'transaction_ref', o.ref, 'branch_id', o.branch_id, 'client_id', o.client_id, 'client_name', o.client_name,
        'port_code', o.port_code, 'port_name', o.port_name, 'driver_id', o.driver_id, 'driver_name', o.driver_name,
        'driver_phone', o.driver_phone, 'truck_plate', o.truck_plate, 'container_id', o.container_id, 'container_no', o.container_no,
        'declaration_no', o.declaration_no, 'bl_number', o.bl_number, 'appointment_at', o.appointment_at,
        'appointment_no', o.appointment_no, 'booking_ref', o.booking_ref, 'appointment_status', o.appointment_status,
        'operator_name', o.operator_name, 'carrier_id', o.carrier_id, 'party_type', o.party_type, 'party_name', o.party_name,
        'transport_order_no', o.transport_order_no, 'origin', o.origin, 'destination', o.destination, 'trip_status', o.trip_status,
        'delivered_at', o.delivered_at,
        'cost_amount', CASE WHEN o.fin THEN round(o.cost_amount, 2) END, 'cost_currency', CASE WHEN o.fin THEN o.cost_currency END,
        'sell_amount', CASE WHEN o.fin THEN round(o.sell_amount, 2) END, 'sell_currency', CASE WHEN o.fin THEN o.sell_currency END,
        'movement_status', o.movement_status, 'return_location', o.return_location, 'return_deadline', o.return_deadline,
        'returned_at', o.returned_at, 'return_status', o.return_status, 'overdue', o.overdue,
        'days_overdue', CASE WHEN o.overdue THEN v_today - o.return_deadline ELSE 0 END, 'notes', o.notes,
        'created_by', o.created_by, 'employee_name', o.employee_name, 'created_at', o.created_at, 'updated_at', o.updated_at)
        ORDER BY o.rn) FROM o WHERE o.rn > v_offset AND o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (SELECT count(*)::int FROM s),
    'limit', v_limit, 'offset', v_offset,
    'fingerprint', (SELECT md5(coalesce(string_agg(s.id::text || ':' || coalesce(s.updated_at::text, ''), ',' ORDER BY s.id), '')) FROM s),
    'finance', v_anyfin, 'today', v_today,
    'totals', jsonb_build_object(
       'count', (SELECT count(*)::int FROM s),
       'appointments', (SELECT count(*)::int FROM s WHERE s.appointment_id IS NOT NULL),
       'cancelled', (SELECT count(*)::int FROM s WHERE s.movement_status = 'cancelled'),
       'delivered_containers', (SELECT count(DISTINCT coalesce(s.container_id::text, 'tx:' || s.transaction_id::text))::int
                                  FROM s WHERE s.movement_status = 'delivered'),
       'overdue_returns', (SELECT count(*)::int FROM s WHERE s.overdue),
       'by_movement_status', coalesce((SELECT jsonb_object_agg(z.ms, z.n) FROM (SELECT s.movement_status ms, count(*)::int n FROM s GROUP BY 1) z), '{}'::jsonb),
       'transport_value', coalesce((SELECT jsonb_object_agg(z.c, z.v) FROM (SELECT s.cost_currency c, round(sum(s.cost_amount), 2) v FROM s
                             WHERE s.fin AND s.movement_status <> 'cancelled' AND s.cost_amount IS NOT NULL GROUP BY 1) z), '{}'::jsonb),
       'revenue', coalesce((SELECT jsonb_object_agg(z.c, z.v) FROM (SELECT s.sell_currency c, round(sum(s.sell_amount), 2) v FROM s
                             WHERE s.fin AND s.movement_status <> 'cancelled' AND s.sell_amount IS NOT NULL GROUP BY 1) z), '{}'::jsonb),
       'rows_with_finance', (SELECT count(*)::int FROM s WHERE s.fin)))
    INTO v_res;
  RETURN v_res;
END $$;

-- report_payments(p_org, filters) — legacy getPaymentsReportR1218 / buildPaymentsExportSheet_ over the step-6 register
-- (client_disbursements). Finance readers only (app.fin_org_read); a row only at a branch where the caller holds fin_read; the
-- transactions / clients / declarations / B/Ls of the allocations only where the caller may read that transaction's finance.
--   keys: app.rpt_pay_keys() — date_field paid (default, the payment DATE) | created (Riyadh day); from / to; status recorded
--         (default) | void | all; funding_source / method / review_status / movement_type / pattern: codes (one or an array);
--         client_id / transaction_id (through the allocations), client_q, service_item_id, service_code, q (legacy haystack: clients,
--         declarations, B/Ls, service, SADAD no., bank reference, receipt, beneficiary, claim, appointment, payer, creator),
--         sort paid_desc (default) | paid_asc | amount_desc | created_desc; limit ≤ 500 (100), offset
--   → {items [...], total, limit, offset, fingerprint, totals {count, paid {CUR: Σ}, expected {CUR: Σ}, difference {CUR: Σ},
--      by_review_status {code: n}, by_movement_type {code: n}}}
CREATE OR REPLACE FUNCTION public.report_payments(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_br uuid; v_tx uuid; v_cl uuid; v_clq text; v_si uuid; v_scode text; v_fs text[];
  v_me text[]; v_rs text[]; v_mt text[]; v_pa text[]; v_st text; v_df text; v_rng date[]; v_from date; v_to date; v_tf timestamptz;
  v_tt timestamptz; v_q text; v_qp text; v_qn text; v_sort text; v_limit int; v_offset int; v_fsc uuid[]; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, app.rpt_pay_keys());
  v_br := app.rpt_branch(p_org, f);
  v_tx := app.puuid(f, 'transaction_id');
  v_cl := app.puuid(f, 'client_id');
  v_clq := app.rpt_like(app.to_western(app.ptext(f, 'client_q', 80)));
  v_si := app.puuid(f, 'service_item_id');
  v_scode := app.ptext(f, 'service_code', 60);
  v_fs := app.rpt_codes(f, 'funding_source', 'fin_funding_source');
  v_me := app.rpt_codes(f, 'method', 'fin_payment_method');
  v_rs := app.rpt_codes(f, 'review_status', 'pay_review_status');
  v_mt := app.rpt_codes(f, 'movement_type', 'pay_movement_type');
  v_pa := app.rpt_codes(f, 'pattern', 'pay_pattern');
  v_st := coalesce(app.ptext(f, 'status', 10), 'recorded');
  IF v_st NOT IN ('recorded','void','all') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_df := coalesce(app.ptext(f, 'date_field', 20), 'paid');
  IF NOT app.is_code('payment_date_field', v_df) THEN PERFORM app.fail('MRS_INVALID', 'date_field'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(app.to_western(v_q)); v_qn := app.rpt_like(app.rpt_norm_no(v_q));
  v_sort := coalesce(app.ptext(f, 'sort', 30), 'paid_desc');
  IF v_sort NOT IN ('paid_desc','paid_asc','amount_desc','created_desc') THEN PERFORM app.fail('MRS_INVALID', 'sort'); END IF;
  v_limit := app.rpt_limit(f, 500, 100);
  v_offset := app.rpt_offset(f);
  v_fsc := app.rpt_scope(p_org, app.fin_read_roles());

  WITH al AS (
    -- the allocations whose transaction the caller may read (finance at the transaction's branch)
    SELECT a.disbursement_id, a.transaction_id, a.client_id, t.ref, t.declaration_no, t.bl_number, cl.name_ar client_name, a.claim_no
      FROM public.disbursement_allocations a
      JOIN public.transactions t ON t.id = a.transaction_id
      JOIN public.clients cl ON cl.id = a.client_id
     WHERE a.org_id = p_org AND a.voided_at IS NULL AND (v_fsc IS NULL OR t.branch_id = ANY (v_fsc))),
  s AS (
    SELECT d.*, si.name_ar service_name_ar, si.name_en service_name_en, pr.full_name created_by_name, b.name_ar branch_name,
           (SELECT count(*)::int FROM public.disbursement_allocations a WHERE a.disbursement_id = d.id AND a.voided_at IS NULL) alloc_n
      FROM public.client_disbursements d
      LEFT JOIN public.org_service_items si ON si.id = d.service_item_id
      LEFT JOIN public.profiles pr ON pr.id = d.created_by
      LEFT JOIN public.branches b ON b.id = d.branch_id
     WHERE d.org_id = p_org AND (v_fsc IS NULL OR d.branch_id = ANY (v_fsc))
       AND (v_st = 'all' OR d.status = v_st)
       AND (v_br IS NULL OR d.branch_id = v_br)
       AND (v_tx IS NULL OR EXISTS (SELECT 1 FROM al WHERE al.disbursement_id = d.id AND al.transaction_id = v_tx))
       AND (v_cl IS NULL OR EXISTS (SELECT 1 FROM al WHERE al.disbursement_id = d.id AND al.client_id = v_cl))
       AND (v_clq IS NULL OR EXISTS (SELECT 1 FROM al JOIN public.clients c ON c.id = al.client_id WHERE al.disbursement_id = d.id
                                       AND (c.name_ar ILIKE v_clq OR c.name_en ILIKE v_clq OR c.cr_number ILIKE v_clq)))
       AND (v_si IS NULL OR d.service_item_id = v_si)
       AND (v_scode IS NULL OR d.service_code = v_scode)
       AND (v_fs IS NULL OR d.funding_source = ANY (v_fs))
       AND (v_me IS NULL OR d.method = ANY (v_me))
       AND (v_rs IS NULL OR d.review_status = ANY (v_rs))
       AND (v_mt IS NULL OR d.movement_type = ANY (v_mt))
       AND (v_pa IS NULL OR d.pattern = ANY (v_pa))
       AND (v_df <> 'paid' OR ((v_from IS NULL OR d.paid_at >= v_from) AND (v_to IS NULL OR d.paid_at <= v_to)))
       AND (v_df <> 'created' OR ((v_tf IS NULL OR d.created_at >= v_tf) AND (v_tt IS NULL OR d.created_at < v_tt)))
       AND (v_q IS NULL OR d.ref ILIKE v_qn OR d.claim_no ILIKE v_qn OR d.appointment_no ILIKE v_qn OR d.sadad_number ILIKE v_qn
            OR d.bank_reference ILIKE v_qn OR d.receipt_no ILIKE v_qn OR d.payer_name ILIKE v_qp OR d.beneficiary_name ILIKE v_qp
            OR d.service_code ILIKE v_qp OR si.name_ar ILIKE v_qp OR si.name_en ILIKE v_qp OR pr.full_name ILIKE v_qp
            OR d.notes ILIKE v_qp
            OR EXISTS (SELECT 1 FROM al WHERE al.disbursement_id = d.id
                         AND (al.client_name ILIKE v_qp OR al.ref ILIKE v_qn OR al.declaration_no ILIKE v_qn OR al.bl_number ILIKE v_qn
                              OR al.claim_no ILIKE v_qn)))),
  o AS (
    SELECT s.*, row_number() OVER (ORDER BY
             CASE WHEN v_sort = 'paid_desc' THEN s.paid_at END DESC NULLS LAST,
             CASE WHEN v_sort = 'paid_asc' THEN s.paid_at END ASC NULLS LAST,
             CASE WHEN v_sort = 'amount_desc' THEN s.paid_amount END DESC NULLS LAST,
             s.created_at DESC, s.id) rn
      FROM s)
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'ref', o.ref, 'branch_id', o.branch_id, 'branch_name', o.branch_name, 'paid_at', o.paid_at,
        'movement_type', o.movement_type, 'pattern', o.pattern, 'service_item_id', o.service_item_id, 'service_code', o.service_code,
        'service_name_ar', o.service_name_ar, 'service_name_en', o.service_name_en, 'fin_service', o.fin_service,
        'claim_no', o.claim_no, 'appointment_no', o.appointment_no, 'currency', o.currency, 'expected_amount', o.expected_amount,
        'paid_amount', o.paid_amount, 'difference', o.difference, 'funding_source', o.funding_source, 'method', o.method,
        'paying_account', o.paying_account, 'payer_name', o.payer_name, 'beneficiary_party_id', o.beneficiary_party_id,
        'beneficiary_name', o.beneficiary_name, 'sadad_number', o.sadad_number, 'bank_reference', o.bank_reference,
        'receipt_no', o.receipt_no, 'review_status', o.review_status, 'status', o.status, 'created_by', o.created_by,
        'created_by_name', o.created_by_name, 'created_at', o.created_at, 'allocation_count', o.alloc_n,
        'client_names', (SELECT string_agg(DISTINCT al.client_name, ' / ') FROM al WHERE al.disbursement_id = o.id),
        'declaration_nos', (SELECT string_agg(DISTINCT al.declaration_no, ' / ') FROM al WHERE al.disbursement_id = o.id),
        'bl_numbers', (SELECT string_agg(DISTINCT al.bl_number, ' / ') FROM al WHERE al.disbursement_id = o.id),
        'transactions', coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', al.transaction_id, 'ref', al.ref))
                                    FROM al WHERE al.disbursement_id = o.id), '[]'::jsonb))
        ORDER BY o.rn) FROM o WHERE o.rn > v_offset AND o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (SELECT count(*)::int FROM s),
    'limit', v_limit, 'offset', v_offset,
    'fingerprint', (SELECT md5(coalesce(string_agg(s.id::text || ':' || coalesce(s.updated_at::text, ''), ',' ORDER BY s.id), '')) FROM s),
    'totals', jsonb_build_object(
       'count', (SELECT count(*)::int FROM s),
       'paid', coalesce((SELECT jsonb_object_agg(z.c, z.v) FROM (SELECT s.currency::text c, round(sum(s.paid_amount), 2) v FROM s GROUP BY 1) z), '{}'::jsonb),
       'expected', coalesce((SELECT jsonb_object_agg(z.c, z.v) FROM (SELECT s.currency::text c, round(sum(s.expected_amount), 2) v FROM s
                                                                     WHERE s.expected_amount IS NOT NULL GROUP BY 1) z), '{}'::jsonb),
       'difference', coalesce((SELECT jsonb_object_agg(z.c, z.v) FROM (SELECT s.currency::text c, round(sum(s.difference), 2) v FROM s
                                                                       WHERE s.difference IS NOT NULL GROUP BY 1) z), '{}'::jsonb),
       'by_review_status', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT s.review_status k, count(*)::int n FROM s GROUP BY 1) z), '{}'::jsonb),
       'by_movement_type', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT s.movement_type k, count(*)::int n FROM s GROUP BY 1) z), '{}'::jsonb)))
    INTO v_res;
  RETURN v_res;
END $$;

-- report_fasah_scope(p_org, p_nos, p_scopes) — the system side of the monthly Fasah reconciliation (legacy
-- fasahR116ReadSystemTransactions_). READ-ONLY. The browser parses the Fasah .xlsx files (assets/js/rpt/fasah-recon.js) and sends
-- only the declaration numbers it read (p_nos, ≤ 20000, each ≤ 40 characters; compared as digits without leading zeros) and the
-- port / month scopes (p_scopes [{port_code, month 'YYYY-MM'}], ≤ 100). Staff, branch-scoped (rows outside the caller's branches
-- are never returned; the caller's scope is part of the result so the screen can say so).
--   → {records [{transaction_id, ref, branch_id, client_name, declaration_id, declaration_no, declaration_no_norm, declaration_date,
--      month, port_code, port_name, declaration_status, operational_status, cancelled, by_no, in_scope}] (≤ 20000), truncated,
--      counts {by_no, in_scope}, ports [{code, name_ar, name_en, kind, unlocode}], scoped (true when only some branches),
--      generated_at}
-- A transaction counts once per (declaration, transaction): the declarations that are not cancelled / replaced, else the
-- transaction's own declaration number when it has no declaration row.
CREATE OR REPLACE FUNCTION public.report_fasah_scope(p_org uuid, p_nos text[], p_scopes jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_nos text[]; v_sc uuid[]; v_scopes jsonb := coalesce(p_scopes, '[]'::jsonb); v_keys text[]; v_res jsonb; e jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  IF cardinality(p_nos) > 20000 THEN PERFORM app.fail('MRS_TOO_LONG', 'nos'); END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_nos, '{}'::text[])) n WHERE char_length(n) > 40) THEN PERFORM app.fail('MRS_TOO_LONG', 'nos'); END IF;
  SELECT coalesce(array_agg(DISTINCT x.d), '{}'::text[]) INTO v_nos
    FROM (SELECT app.rpt_digits_no(n) d FROM unnest(coalesce(p_nos, '{}'::text[])) n) x WHERE x.d IS NOT NULL;
  IF jsonb_typeof(v_scopes) <> 'array' OR jsonb_array_length(v_scopes) > 100 THEN PERFORM app.fail('MRS_INVALID', 'scopes'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(v_scopes) LOOP
    IF jsonb_typeof(e) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('port_code','month'))
       OR jsonb_typeof(e -> 'port_code') IS DISTINCT FROM 'string' OR jsonb_typeof(e -> 'month') IS DISTINCT FROM 'string'
       OR (e ->> 'month') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
       OR NOT EXISTS (SELECT 1 FROM public.customs_ports p WHERE p.code = upper(e ->> 'port_code')) THEN
      PERFORM app.fail('MRS_INVALID', 'scopes');
    END IF;
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT upper(x ->> 'port_code') || '|' || (x ->> 'month')), '{}'::text[]) INTO v_keys
    FROM jsonb_array_elements(v_scopes) x;
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  WITH dec AS (
    SELECT t.id tx, t.ref, t.branch_id, t.port_code, t.operational_status, t.cancelled_at, cl.name_ar client_name,
           d.id did, d.declaration_no, coalesce(d.declaration_date, t.declaration_date) ddate, d.status
      FROM public.transactions t JOIN public.clients cl ON cl.id = t.client_id
      JOIN public.customs_declarations d ON d.transaction_id = t.id AND d.status NOT IN ('cancelled','replaced')
     WHERE t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
    UNION ALL
    SELECT t.id, t.ref, t.branch_id, t.port_code, t.operational_status, t.cancelled_at, cl.name_ar, NULL::uuid, t.declaration_no,
           t.declaration_date, NULL::text
      FROM public.transactions t JOIN public.clients cl ON cl.id = t.client_id
     WHERE t.org_id = p_org AND (v_sc IS NULL OR t.branch_id = ANY (v_sc)) AND t.declaration_no IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.status NOT IN ('cancelled','replaced'))),
  m AS (
    SELECT dec.*, app.rpt_digits_no(dec.declaration_no) dno, to_char(dec.ddate, 'YYYY-MM') mon FROM dec),
  hit AS (
    SELECT m.*, (m.dno = ANY (v_nos)) by_no, (m.port_code IS NOT NULL AND m.ddate IS NOT NULL AND (m.port_code || '|' || m.mon) = ANY (v_keys)) in_scope
      FROM m WHERE m.dno IS NOT NULL),
  sel AS (SELECT * FROM hit WHERE hit.by_no OR hit.in_scope)
  SELECT jsonb_build_object(
    'records', coalesce((SELECT jsonb_agg(jsonb_build_object('transaction_id', z.tx, 'ref', z.ref, 'branch_id', z.branch_id,
        'client_name', z.client_name, 'declaration_id', z.did, 'declaration_no', z.declaration_no, 'declaration_no_norm', z.dno,
        'declaration_date', z.ddate, 'month', z.mon, 'port_code', z.port_code, 'port_name', cp.name_ar,
        'declaration_status', coalesce(z.status, app.rpt_decl_status(z.tx)), 'operational_status', z.operational_status,
        'cancelled', z.cancelled_at IS NOT NULL, 'by_no', z.by_no, 'in_scope', z.in_scope)
        ORDER BY z.ddate DESC NULLS LAST, z.dno DESC, z.tx)
        FROM (SELECT * FROM sel ORDER BY sel.ddate DESC NULLS LAST, sel.dno DESC, sel.tx LIMIT 20000) z
        LEFT JOIN public.customs_ports cp ON cp.code = z.port_code), '[]'::jsonb),
    'truncated', (SELECT count(*) > 20000 FROM sel),
    'counts', jsonb_build_object('by_no', (SELECT count(*)::int FROM sel WHERE sel.by_no),
                                 'in_scope', (SELECT count(*)::int FROM sel WHERE sel.in_scope)),
    'ports', coalesce((SELECT jsonb_agg(jsonb_build_object('code', p.code, 'name_ar', p.name_ar, 'name_en', p.name_en, 'kind', p.kind,
                         'unlocode', p.unlocode) ORDER BY p.sort, p.code) FROM public.customs_ports p WHERE p.is_active), '[]'::jsonb),
    'scoped', v_sc IS NOT NULL, 'generated_at', now())
    INTO v_res;
  RETURN v_res;
END $$;

-- get_status_aging_rules(p_org) — staff: {rules (effective), defaults, overrides (stored), email_otp_login, can_edit}
CREATE OR REPLACE FUNCTION public.get_status_aging_rules(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_set jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  SELECT o.settings INTO v_set FROM public.organizations o WHERE o.id = p_org;
  RETURN jsonb_build_object('rules', app.status_aging_rules(p_org), 'defaults', app.status_aging_defaults(),
    'overrides', CASE WHEN jsonb_typeof(v_set -> 'status_aging_rules') = 'object' THEN v_set -> 'status_aging_rules' ELSE '{}'::jsonb END,
    'email_otp_login', coalesce(v_set ->> 'email_otp_login', '') = 'true',
    'can_edit', app.has_role(p_org, ARRAY['admin']) AND app.rpt_scope(p_org, ARRAY['admin']) IS NULL);
END $$;

-- set_status_aging_rules(p_org, p_rules, p_reason) — the org admin (org-wide, MFA through has_role) overrides the aging rules:
-- p_rules = {status | 'appointment_not_updated': {warning_hours, critical_hours} | null (rule off)} — replaces the stored
-- overrides ({} = back to the defaults). Reason required (≤ 500). Written to organizations.settings.status_aging_rules (audited by
-- the organizations trail). → get_status_aging_rules(p_org)
CREATE OR REPLACE FUNCTION public.set_status_aging_rules(p_org uuid, p_rules jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) OR app.rpt_scope(p_org, ARRAY['admin']) IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
  END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  PERFORM app.aging_rules_check(coalesce(p_rules, '{}'::jsonb));
  UPDATE public.organizations o
     SET settings = jsonb_set(coalesce(o.settings, '{}'::jsonb), '{status_aging_rules}', coalesce(p_rules, '{}'::jsonb))
                    || jsonb_build_object('status_aging_rules_reason', left(v_reason, 500))
   WHERE o.id = p_org;
  RETURN public.get_status_aging_rules(p_org);
END $$;

-- set_email_otp_login(p_org, p_enabled, p_reason) — the org admin (org-wide, aal2) allows / forbids the e-mail code login for the
-- members of the org (OFF by default). The login page shows the e-mail code only when the platform switch of the site
-- configuration is on as well; after an e-mail code login the page calls otp_session_check() and signs out when not allowed.
CREATE OR REPLACE FUNCTION public.set_email_otp_login(p_org uuid, p_enabled boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) OR app.rpt_scope(p_org, ARRAY['admin']) IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
  END IF;
  IF p_enabled IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'enabled'); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.organizations o
     SET settings = coalesce(o.settings, '{}'::jsonb) || jsonb_build_object('email_otp_login', p_enabled,
                                                                            'email_otp_login_reason', left(v_reason, 500))
   WHERE o.id = p_org;
  RETURN public.get_status_aging_rules(p_org);
END $$;

-- otp_session_check() — any signed-in user, about THIS session: was it opened with an e-mail code (JWT amr method otp /
-- magiclink / email) and is that allowed? Allowed = not an e-mail code session, or the user has at least one active staff
-- membership and EVERY active org of the user's memberships enabled email_otp_login (a portal-only user is never allowed).
-- MFA is unchanged: an e-mail code session is aal1, so admin rights still need the TOTP step (app.mfa_ok); mfa_pending says so.
--   → {otp_session, allowed, reason ('password' | 'ok' | 'org_disabled' | 'no_staff_membership'), aal, mfa_pending}
-- Advisory, and asked only for a session that the site's code form opened (supa.js otpGate marker): in GoTrue's implicit flow a
-- password-reset / sign-up / invite confirmation link session carries the same amr 'otp', so the server cannot tell it from a
-- code login. Not an RLS boundary on purpose (review 2026-11-11): an e-mail proof already resets the password, so gating amr in
-- has_role / is_member would only break those links, not stop a mailbox holder. The boundary is MFA (aal2, app.mfa_ok).
CREATE OR REPLACE FUNCTION public.otp_session_check() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_otp boolean; v_staff int; v_off int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT coalesce(bool_or(e ->> 'method' IN ('otp','magiclink','email')), false) INTO v_otp
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END) e;
  SELECT count(*) FILTER (WHERE m.role <> 'client'),
         count(*) FILTER (WHERE coalesce(o.settings ->> 'email_otp_login', '') <> 'true')
    INTO v_staff, v_off
    FROM public.memberships m JOIN public.organizations o ON o.id = m.org_id AND o.is_active
   WHERE m.user_id = auth.uid() AND m.is_active;
  RETURN jsonb_build_object('otp_session', v_otp,
    'allowed', NOT v_otp OR (v_staff > 0 AND v_off = 0),
    'reason', CASE WHEN NOT v_otp THEN 'password' WHEN v_staff = 0 THEN 'no_staff_membership' WHEN v_off > 0 THEN 'org_disabled' ELSE 'ok' END,
    'aal', app.session_aal(), 'mfa_pending', app.mfa_pending());
END $$;

-- audit_trail(p_org, {transaction_id, table_name, row_id, actor, from, to, limit ≤ 200 (50), before_id}) — the operations log
-- with business labels and the field-level diff (legacy recordSystemAuditEvent / buildTransactionAuditDetails). Same readers as
-- the audit_log policy (admin / supervisor of the org). transaction_id = the transaction row and the rows of its containers,
-- appointments, trips, declarations, empty-return proofs and billing intents (also deleted ones: their old row carries it).
--   → {items [{id, at, table_name, row_id, action, actor, actor_name, actor_role, label (audit_label code), event {type,
--      from_status, to_status, note} | null (the transaction event written in the same database transaction), changes
--      [{field, from, to}], transaction_id, transaction_ref, container_no}], next_before_id}
-- one transaction's child audit rows (audit_trail with transaction_id): partial expression index, the only index of this file
CREATE INDEX IF NOT EXISTS audit_log_tx_child_idx ON public.audit_log (org_id, ((coalesce(new_data, old_data) ->> 'transaction_id')), id DESC)
  WHERE table_name IN ('containers','port_appointments','transport_trips','customs_declarations','empty_return_proofs','billing_intents');
CREATE OR REPLACE FUNCTION public.audit_trail(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb); v_tx uuid; v_table text; v_row text; v_actor uuid; v_rng date[]; v_tf timestamptz;
  v_tt timestamptz; v_limit int; v_before bigint; v_items jsonb; v_n int; v_ids bigint[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','supervisor']) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(f, ARRAY['transaction_id','table_name','row_id','actor','from','to','limit','before_id']);
  v_tx := app.puuid(f, 'transaction_id');
  IF v_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = v_tx AND t.org_id = p_org) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;
  v_table := app.ptext(f, 'table_name', 63);
  IF v_table !~ '^[a-z_]{1,63}$' THEN PERFORM app.fail('MRS_INVALID', 'table_name'); END IF;
  v_row := app.ptext(f, 'row_id', 100);
  v_actor := app.puuid(f, 'actor');
  v_rng := app.rpt_range(f, 1096);
  v_tf := app.rpt_ts(v_rng[1]); v_tt := app.rpt_ts(v_rng[2] + 1);
  v_limit := app.rpt_limit(f, 200, 50);
  IF f ? 'before_id' AND f ->> 'before_id' IS NOT NULL THEN
    IF (f ->> 'before_id') !~ '^[0-9]{1,18}$' THEN PERFORM app.fail('MRS_INVALID', 'before_id'); END IF;
    v_before := (f ->> 'before_id')::bigint;
  END IF;
  -- the page of ids first. One transaction's log (the «سجل العمليات على المعاملة» section) is read through two indexes —
  -- audit_log_row_idx for the transaction row, audit_log_tx_child_idx for its child rows — never by walking the org's whole log
  -- (the child list must stay the literal of that partial index)
  IF v_tx IS NULL THEN
    SELECT array_agg(z.id ORDER BY z.id DESC) INTO v_ids FROM (
      SELECT a.id FROM public.audit_log a
       WHERE a.org_id = p_org
         AND (v_table IS NULL OR a.table_name = v_table)
         AND (v_row IS NULL OR a.row_id = v_row)
         AND (v_actor IS NULL OR a.actor = v_actor)
         AND (v_tf IS NULL OR a.at >= v_tf) AND (v_tt IS NULL OR a.at < v_tt)
         AND (v_before IS NULL OR a.id < v_before)
       ORDER BY a.id DESC LIMIT v_limit) z;
  ELSE
    SELECT array_agg(z.id ORDER BY z.id DESC) INTO v_ids FROM (
      SELECT c.id FROM (
        SELECT a.id, a.table_name, a.row_id, a.actor, a.at FROM public.audit_log a
         WHERE a.table_name = 'transactions' AND a.row_id = v_tx::text AND a.org_id = p_org
        UNION ALL
        SELECT a.id, a.table_name, a.row_id, a.actor, a.at FROM public.audit_log a
         WHERE a.org_id = p_org
           AND a.table_name IN ('containers','port_appointments','transport_trips','customs_declarations','empty_return_proofs','billing_intents')
           AND (coalesce(a.new_data, a.old_data) ->> 'transaction_id') = v_tx::text) c
       WHERE (v_table IS NULL OR c.table_name = v_table)
         AND (v_row IS NULL OR c.row_id = v_row)
         AND (v_actor IS NULL OR c.actor = v_actor)
         AND (v_tf IS NULL OR c.at >= v_tf) AND (v_tt IS NULL OR c.at < v_tt)
         AND (v_before IS NULL OR c.id < v_before)
       ORDER BY c.id DESC LIMIT v_limit) z;
  END IF;
  WITH x AS (
    SELECT a.* FROM public.audit_log a WHERE a.id = ANY (coalesce(v_ids, '{}'::bigint[]))),
  y AS (
    SELECT x.*, CASE WHEN x.table_name = 'transactions' THEN x.row_id ELSE coalesce(x.new_data, x.old_data) ->> 'transaction_id' END txid
      FROM x)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', y.id, 'at', y.at, 'table_name', y.table_name, 'row_id', y.row_id, 'action', y.action, 'actor', y.actor,
           'actor_name', pr.full_name, 'actor_role', y.actor_role,
           'label', app.audit_label_of(y.table_name, y.action, coalesce(y.changed_fields, '{}'::text[])),
           'event', (SELECT jsonb_build_object('type', e.event_type, 'from_status', e.from_status, 'to_status', e.to_status, 'note', e.note)
                       FROM public.transaction_events e
                      WHERE y.txid ~* '^[0-9a-f-]{36}$' AND e.transaction_id = y.txid::uuid AND e.created_at = y.at
                      ORDER BY e.id LIMIT 1),
           'changes', app.audit_changes(y.action, y.changed_fields, y.old_data, y.new_data),
           'transaction_id', y.txid, 'transaction_ref', t.ref,
           'container_no', CASE WHEN y.table_name = 'containers' THEN coalesce(y.new_data, y.old_data) ->> 'container_no'
                                ELSE (SELECT c.container_no FROM public.containers c
                                       WHERE (coalesce(y.new_data, y.old_data) ->> 'container_id') ~* '^[0-9a-f-]{36}$'
                                         AND c.id = (coalesce(y.new_data, y.old_data) ->> 'container_id')::uuid) END)
           ORDER BY y.id DESC), '[]'::jsonb), count(*)
    INTO v_items, v_n
    FROM y
    LEFT JOIN public.profiles pr ON pr.id = y.actor
    LEFT JOIN public.transactions t ON y.txid ~* '^[0-9a-f-]{36}$' AND t.id = y.txid::uuid;
  RETURN jsonb_build_object('items', v_items,
    'next_before_id', CASE WHEN v_n = v_limit THEN (SELECT min((i ->> 'id')::bigint) FROM jsonb_array_elements(v_items) i) END);
END $$;

-- ---------------------------------------------------------------------
-- 4. privileges
-- ---------------------------------------------------------------------
-- the step-8 helpers and the re-created G6a / G3 helpers: revoked from everyone (the SECURITY DEFINER RPCs run them as owner;
-- no policy uses them)
REVOKE ALL ON FUNCTION app.rpt_digits_no(text), app.rpt_ports(jsonb, text), app.rpt_num_range(jsonb, text, text, text, numeric),
  app.rpt_decl_status(uuid), app.rpt_unit_count(uuid), app.rpt_daftra_state(uuid), app.rpt_daftra_json(uuid), app.rpt_billed(uuid),
  app.status_aging_defaults(), app.aging_rules_check(jsonb), app.status_aging_rules(uuid),
  app.att_reasons(uuid, uuid[], timestamptz), app.att_json(uuid, uuid, timestamptz), app.att_ids(uuid, text, timestamptz),
  app.rpt_mv(uuid), app.rpt_mv_keys(), app.rpt_pay_keys(), app.audit_label_of(text, text, text[]),
  app.audit_changes(text, text[], jsonb, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
-- re-created functions: privileges as in their first migration (CREATE OR REPLACE keeps them; restated)
REVOKE ALL ON FUNCTION app.rpt_search_keys(), app.rpt_trip_keys(), app.rpt_export_keys(text), app.rpt_tx_match(uuid, jsonb),
  app.rpt_tx_json(uuid, jsonb, boolean), app.rpt_tx_sort(jsonb), app.rpt_tx_result(uuid[], jsonb, text, int, int, boolean),
  app.alert_causes(uuid, timestamptz)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_transactions(uuid, jsonb), public.report_trips(uuid, jsonb), public.log_report_export(uuid, jsonb)
FROM PUBLIC, anon, authenticated;
-- staff RPCs: authenticated only (each checks its own gate)
REVOKE ALL ON FUNCTION public.dash_tx_counts(uuid, jsonb), public.tx_attention(uuid, jsonb), public.report_movements(uuid, jsonb),
  public.report_payments(uuid, jsonb), public.report_fasah_scope(uuid, text[], jsonb), public.get_status_aging_rules(uuid),
  public.set_status_aging_rules(uuid, jsonb, text), public.set_email_otp_login(uuid, boolean, text), public.otp_session_check(),
  public.audit_trail(uuid, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_transactions(uuid, jsonb), public.report_trips(uuid, jsonb), public.log_report_export(uuid, jsonb),
  public.dash_tx_counts(uuid, jsonb), public.tx_attention(uuid, jsonb), public.report_movements(uuid, jsonb),
  public.report_payments(uuid, jsonb), public.report_fasah_scope(uuid, text[], jsonb), public.get_status_aging_rules(uuid),
  public.set_status_aging_rules(uuid, jsonb, text), public.set_email_otp_login(uuid, boolean, text), public.otp_session_check(),
  public.audit_trail(uuid, jsonb)
TO authenticated;
