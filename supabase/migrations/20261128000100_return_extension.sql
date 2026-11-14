-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261128000100 — empty-container return deadline → extension request to the shipping agent (the
-- owner's voice note: after the declaration, follow the empty return deadline «مهلة إرجاع الحاوية الفارغة»; when it is near,
-- warn that an EXTENSION must be requested from the shipping agent; the program prepares the extension request e-mail and we
-- approve the message — «خطوة بخطوة»). Builds on G3 (containers.return_deadline, set_container_return, operational exceptions
-- 'detention_extension', alert_causes / refresh_alerts_core, 20261103000200), legacy_reports (the status-aging rules pattern,
-- 20261124000100) and legacy_import (the latest alert_causes / convert_delete_tables bodies, 20261125000100).
--   P. preflight (tx_draft_approval applied, set_container_return / exc_insert / alert_causes present) + schema_versions row
--   1. rules        organizations.settings.empty_return_rules = {lead_days 1..30 (default 3 = today's fixed +3), default_request_days
--                   1..30 (default 7)}: app.empty_return_rules_defaults(), app.empty_return_rules_check(jsonb) (only these keys,
--                   whole numbers in range → MRS_INVALID empty_return_rule), app.empty_return_rules(p_org) (defaults overlaid with the
--                   valid stored values; never fails), public.get_empty_return_rules(p_org) (staff), public.set_empty_return_rules
--                   (p_org, p_rules, p_reason) (the org owner: org-wide admin, aal2, reason required — the set_status_aging_rules
--                   pattern, audited by the organizations trail). No new table.
--   2. table        public.return_extension_requests — one extension request per shipping agent of a transaction: containers
--                   (uuid[] 1..200, each a container of the transaction: trigger guard), the snapshot of the earliest deadline,
--                   requested days / date, the agent (+ its B/L), to_address, subject / body (Arabic + English, editable), status
--                   draft → sent (the user's statement «تم الإرسال») → approved | partially_approved | rejected, or cancelled; the
--                   agent's new date, the decision note / document / inbox thread; the linked 'detention_extension' exception.
--                   One active (draft / sent) request per transaction + agent and a container in one active request only.
--                   Staff of the branch read it (RLS); written only by the RPCs; never shown in the client portal.
--   3. text         the built-in subject / body + an org override (organizations.settings.return_extension_template {subject,
--                   body}, public.set_return_extension_template(p_org, p_tpl, p_reason), owner + reason); plain {{key}}
--                   substitution over a fixed placeholder list (unknown → MRS_INVALID placeholder), rendered server-side.
--                   msg_templates is NOT used: its four-eyes review and fixed key / placeholder CHECKs would block a sole owner.
--   4. events       transaction_events_event_type_check = the 20261127000100 list + 'return_extension' (payload {op prepared |
--                   updated | sent | decided | cancelled, request_id, container_ids, requested_until / decided_until}; never
--                   client visible); status_labels audit_event.return_extension, return_extension_status.*, alert_kind
--                   empty_return_no_deadline.
--   5. alerts       app.alert_causes re-created from 20261125000100 with only the empty-return branch changed: the threshold is
--                   lead_days (Asia/Riyadh day), the title says what to do («اطلب تمديدًا من الوكيل الملاحي» / «طلب التمديد مُرسَل
--                   بانتظار رد الوكيل الملاحي» / «طلب التمديد جاهز ولم يُرسَل بعد»), kinds and dedupe keys unchanged; + a new
--                   branch 'empty_return_no_deadline' (a container that gated out with no deadline, warning). The
--                   operational_alerts kind CHECK = the 20261124000100 list + empty_return_no_deadline.
--   6. RPCs         public.prepare_return_extension(p_tx, p_payload), public.update_return_extension(p_id, p_payload),
--                   public.mark_return_extension_sent(p_id, p_note), public.decide_return_extension(p_id, p_payload),
--                   public.cancel_return_extension(p_id, p_reason), public.list_return_extensions(p_tx, p_status) — transport
--                   writers of the branch write, staff read. decide (approved / partially_approved) moves return_deadline of the
--                   still-open containers through public.set_container_return (its rules and its 'return_plan' event);
--                   returned / waived containers are skipped. demurrage_cases are never touched (a hint is returned).
--   7. conversion   app.convert_delete_tables re-created (20261125000100 body + public.return_extension_requests).
--   8. privileges
-- SENDING: the program never sends this e-mail. The page opens it in the user's own mail program (mailto:) or copies it; the
-- user sends it (ideally from ops@marsacloud.com so the agent's reply lands in the inbox and links by ref + B/L + container) and
-- presses «تم الإرسال» (mark_return_extension_sent records that statement). No msg_outbound / SMTP / AI row is written: the G6b
-- inbox (four-eyes CHECK, templates, outbound) is untouched.
-- Errors: MRS_RX_EXISTS (an active request of the same agent, or a container already in another active request); existing
-- codes otherwise (MRS_REQUIRED container_ids / return_deadline / bl_id / to_address / note / decided_until / outcome,
-- MRS_INVALID container_ids / bl_id / agent_party_id / to_address / requested_days / requested_until / decided_until / outcome /
-- msg_thread_id / document_id / placeholder / empty_return_rule / template, MRS_BAD_TRANSITION <status> | cancelled,
-- MRS_NOTE_REQUIRED reason, MRS_TOO_LONG, MRS_FORBIDDEN owner_only | role, MRS_NOT_FOUND, MRS_IDEMPOTENCY_CONFLICT).
-- Re-runnable (CREATE TABLE / INDEX IF NOT EXISTS, DROP CONSTRAINT / POLICY / TRIGGER IF EXISTS + ADD, CREATE OR REPLACE,
-- ON CONFLICT); re-running on itself leaves an identical catalog; changes no data (default lead_days 3 = today's alerts).
-- Re-pasting 20261103000200, 20261117000100, 20261124000100 or 20261125000100 after this file restores the fixed +3 and the old
-- titles of alert_causes (and drops the new alert branch / the table from the conversion list); re-pasting 20261127000100 or an
-- older file narrows the event types (and aborts once a 'return_extension' event exists), 20261124000100 narrows the alert
-- kinds (aborts once an empty_return_no_deadline alert exists): re-paste this file right after.
-- Down-path (staging only): cancel the open requests first; DROP FUNCTION the 6 RPCs + get / set_empty_return_rules +
-- set_return_extension_template + the app.rx_* / empty_return_rules* helpers (after re-pasting 20261125000100 §alert_causes /
-- §convert_delete_tables); DELETE FROM public.operational_alerts WHERE kind = 'empty_return_no_deadline'; re-paste 20261124000100
-- §(alert kinds) and 20261127000100 §4 (event types) only when no 'return_extension' event exists; DROP TABLE
-- public.return_extension_requests.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261127000100') THEN
    RAISE EXCEPTION 'RETURN EXTENSION preflight: apply tx_draft_approval first (schema_versions lacks 20261127000100 tx_draft_approval)';
  END IF;
  IF to_regprocedure('public.set_container_return(uuid,jsonb)') IS NULL
     OR to_regprocedure('app.exc_insert(public.transactions,text,text,text,uuid,uuid,uuid,numeric,text,timestamptz)') IS NULL
     OR to_regprocedure('app.alert_causes(uuid,timestamptz)') IS NULL OR to_regprocedure('app.g3_lock_tx(uuid,text[])') IS NULL
     OR to_regprocedure('app.tg_legacy_docs_audit()') IS NULL OR to_regclass('public.msg_threads') IS NULL THEN
    RAISE EXCEPTION 'RETURN EXTENSION preflight: G3 / G6b / legacy objects missing (apply 20261103000200 … 20261127000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261128000100', 'return_extension')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. rules: organizations.settings.empty_return_rules
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.empty_return_rules_defaults() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '{"lead_days": 3, "default_request_days": 7}'::jsonb
$$;
-- an override object {lead_days?, default_request_days?} (whole numbers 1..30) → the same object, or MRS_INVALID 'empty_return_rule'
CREATE OR REPLACE FUNCTION app.empty_return_rules_check(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb; n numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'empty_return_rule'); END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p) LOOP
    IF NOT (app.empty_return_rules_defaults() ? k) OR jsonb_typeof(v) IS DISTINCT FROM 'number' THEN
      PERFORM app.fail('MRS_INVALID', 'empty_return_rule');
    END IF;
    n := (v #>> '{}')::numeric;
    IF n <> trunc(n) OR n < 1 OR n > 30 THEN PERFORM app.fail('MRS_INVALID', 'empty_return_rule'); END IF;
  END LOOP;
  RETURN p;
END $$;
-- the rules in force of an org: the defaults overlaid with the valid stored values (an invalid stored value is ignored, never fails:
-- the alert refresh of every org reads it)
CREATE OR REPLACE FUNCTION app.empty_return_rules(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.empty_return_rules_defaults() || coalesce((
    SELECT jsonb_object_agg(x.key, (x.value #>> '{}')::int)
      FROM public.organizations o, jsonb_each(CASE WHEN jsonb_typeof(o.settings -> 'empty_return_rules') = 'object'
                                                   THEN o.settings -> 'empty_return_rules' ELSE '{}'::jsonb END) x
     WHERE o.id = p_org AND x.key IN ('lead_days','default_request_days') AND jsonb_typeof(x.value) = 'number'
       AND (x.value #>> '{}') ~ '^[0-9]{1,2}$' AND (x.value #>> '{}')::int BETWEEN 1 AND 30), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------
-- 2. table: public.return_extension_requests
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.return_extension_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  transaction_id       uuid NOT NULL,
  bl_id                uuid,
  agent_party_id       uuid,
  container_ids        uuid[] NOT NULL,
  current_deadline     date NOT NULL,
  requested_days       int NOT NULL CHECK (requested_days BETWEEN 1 AND 60),
  requested_until      date NOT NULL,
  to_address           text CHECK (char_length(to_address) <= 160 AND to_address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  subject              text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  body                 text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  text_edited          boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','partially_approved','rejected','cancelled')),
  sent_at              timestamptz,
  sent_by              uuid,
  sent_note            text CHECK (char_length(sent_note) <= 500),
  decided_until        date,
  decision_note        text CHECK (char_length(decision_note) <= 1000),
  decision_document_id uuid,
  decided_at           timestamptz,
  decided_by           uuid,
  cancelled_at         timestamptz,
  cancel_reason        text CHECK (char_length(cancel_reason) <= 500),
  exception_id         uuid NOT NULL,
  msg_thread_id        uuid,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_extension_requests_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT return_extension_requests_bl_fk FOREIGN KEY (bl_id, org_id) REFERENCES public.bills_of_lading(id, org_id),
  CONSTRAINT return_extension_requests_agent_fk FOREIGN KEY (agent_party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT return_extension_requests_exception_fk FOREIGN KEY (exception_id, org_id) REFERENCES public.operational_exceptions(id, org_id),
  CONSTRAINT return_extension_requests_doc_fk FOREIGN KEY (decision_document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT return_extension_requests_thread_fk FOREIGN KEY (msg_thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT return_extension_requests_containers_chk CHECK (cardinality(container_ids) BETWEEN 1 AND 200 AND array_position(container_ids, NULL) IS NULL),
  CONSTRAINT return_extension_requests_until_chk CHECK (requested_until >= current_deadline),
  CONSTRAINT return_extension_requests_sent_chk CHECK ((status <> 'sent' OR sent_at IS NOT NULL) AND (status <> 'draft' OR sent_at IS NULL)
                                                       AND (sent_at IS NULL) = (sent_by IS NULL)),
  CONSTRAINT return_extension_requests_decided_chk CHECK ((status IN ('approved','partially_approved','rejected')) = (decided_at IS NOT NULL)
                                                          AND (decided_at IS NULL) = (decided_by IS NULL)
                                                          AND (status NOT IN ('approved','partially_approved')
                                                               OR (decided_until IS NOT NULL AND decided_until > current_deadline))
                                                          AND (status <> 'rejected' OR decided_until IS NULL)),
  CONSTRAINT return_extension_requests_cancel_chk CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)
                                                         AND (cancelled_at IS NULL) = (cancel_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.return_extension_requests IS 'Empty-container return deadline extension requests to the shipping agent (20261128000100): prepared by the program (subject / body rendered server-side, editable), SENT BY THE USER from their own mail program (mailto / copy; «تم الإرسال» is the user''s statement — the program sends nothing), then the agent''s answer is recorded (decide_return_extension moves containers.return_deadline through set_container_return). Linked to a detention_extension operational exception. Staff only; written only by the RPCs.';
COMMENT ON COLUMN public.return_extension_requests.current_deadline IS 'Snapshot when prepared: the earliest return_deadline of the containers of the request.';
COMMENT ON COLUMN public.return_extension_requests.text_edited IS 'true once the user edited subject / body: a later change of the days / date / containers no longer re-renders the text (rerender: true does).';
CREATE INDEX IF NOT EXISTS return_extension_requests_tx_idx ON public.return_extension_requests (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS return_extension_requests_active_idx ON public.return_extension_requests (org_id, status) WHERE status IN ('draft','sent');
CREATE UNIQUE INDEX IF NOT EXISTS return_extension_requests_active_uidx ON public.return_extension_requests
  (transaction_id, coalesce(agent_party_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('draft','sent');

-- guard: the containers belong to the transaction (no duplicates); a final request (decided / cancelled) never changes; the
-- identity columns never change
CREATE OR REPLACE FUNCTION app.tg_return_extension_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT count(DISTINCT x) FROM unnest(NEW.container_ids) x) <> cardinality(NEW.container_ids)
     OR EXISTS (SELECT 1 FROM unnest(NEW.container_ids) x
                 WHERE NOT EXISTS (SELECT 1 FROM public.containers c WHERE c.id = x AND c.transaction_id = NEW.transaction_id)) THEN
    PERFORM app.fail('MRS_INVALID', 'container_ids');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('approved','partially_approved','rejected','cancelled') THEN PERFORM app.fail('MRS_IMMUTABLE', 'status'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','transaction_id','exception_id','created_by','created_at']);
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard ON public.return_extension_requests;
CREATE TRIGGER trg_guard BEFORE INSERT OR UPDATE ON public.return_extension_requests FOR EACH ROW EXECUTE FUNCTION app.tg_return_extension_guard();
-- the trail without the message text
DROP TRIGGER IF EXISTS trg_audit ON public.return_extension_requests;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.return_extension_requests FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('subject', 'body');

-- ---------------------------------------------------------------------
-- 3. the message text: built-in default, org override, placeholders
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rx_placeholders() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['tx_ref','bl_number','agent_name','agent_name_en','container_list','container_first','container_count',
               'current_deadline','requested_days','requested_until','org_name','signature','today']
$$;
-- Arabic paragraph, then English; short enough for a mailto: link
CREATE OR REPLACE FUNCTION app.rx_builtin_template() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'subject', 'طلب تمديد مهلة إرجاع الحاويات الفارغة / Detention extension request — {{tx_ref}} — B/L {{bl_number}} — {{container_first}}',
    'body', E'السادة {{agent_name}} المحترمين،\n'
         || E'السلام عليكم ورحمة الله وبركاته،\n\n'
         || E'نرجو التكرم بتمديد مهلة إرجاع الحاويات الفارغة الخاصة بالبوليصة رقم {{bl_number}} (مرجعنا {{tx_ref}}) لمدة {{requested_days}} يومًا حتى تاريخ {{requested_until}}، وعددها {{container_count}}:\n'
         || E'{{container_list}}\n\n'
         || E'نأمل تأكيد التمديد كتابيًا مع تاريخ نهاية المهلة الجديد.\n'
         || E'وتفضلوا بقبول فائق الاحترام،\n{{signature}}\n\n'
         || E'Dear {{agent_name_en}},\n\n'
         || E'Please extend the free time for returning the empty containers of B/L {{bl_number}} (our ref. {{tx_ref}}) by {{requested_days}} days, until {{requested_until}} ({{container_count}} containers, number — current deadline):\n'
         || E'{{container_list}}\n\n'
         || E'Kindly confirm the extension in writing with the new free-time end date.\n'
         || E'Best regards,\n{{signature}}')
$$;
-- every {{key}} of a text must be a known placeholder → MRS_INVALID 'placeholder'
CREATE OR REPLACE FUNCTION app.rx_placeholders_check(p text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM regexp_matches(coalesce(p, ''), '\{\{([^{}]*)\}\}', 'g') m
              WHERE NOT (btrim(m[1]) = ANY (app.rx_placeholders())) OR m[1] <> btrim(m[1])) THEN
    PERFORM app.fail('MRS_INVALID', 'placeholder');
  END IF;
END $$;
-- the template in force: the org override {subject, body} when valid, else the built-in one
CREATE OR REPLACE FUNCTION app.rx_template(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT jsonb_build_object('subject', o.settings #>> '{return_extension_template,subject}',
                                             'body', o.settings #>> '{return_extension_template,body}', 'custom', true)
                     FROM public.organizations o
                    WHERE o.id = p_org AND jsonb_typeof(o.settings -> 'return_extension_template') = 'object'
                      AND coalesce(o.settings #>> '{return_extension_template,subject}', '') <> ''
                      AND coalesce(o.settings #>> '{return_extension_template,body}', '') <> ''),
                  app.rx_builtin_template() || jsonb_build_object('custom', false))
$$;
CREATE OR REPLACE FUNCTION app.rx_render(p_text text, p_vars jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := coalesce(p_text, ''); k text;
BEGIN
  FOREACH k IN ARRAY app.rx_placeholders() LOOP
    v := replace(v, '{{' || k || '}}', coalesce(p_vars ->> k, ''));
  END LOOP;
  RETURN v;
END $$;
-- the placeholder values of a request (the containers with their current deadline, the agent, the B/L, the signature of the caller)
CREATE OR REPLACE FUNCTION app.rx_vars(r public.return_extension_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'tx_ref', t.ref,
    'bl_number', coalesce((SELECT b.bl_number FROM public.bills_of_lading b WHERE b.id = r.bl_id), t.bl_number, '—'),
    'agent_name', coalesce(pa.name_ar, 'الوكيل الملاحي'),
    'agent_name_en', coalesce(nullif(pa.name_en, ''), pa.name_ar, 'Shipping agent'),
    'container_list', (SELECT string_agg('- ' || c.container_no || ' — ' || coalesce(to_char(c.return_deadline, 'YYYY-MM-DD'), '—'),
                                         E'\n' ORDER BY c.container_no)
                         FROM public.containers c WHERE c.id = ANY (r.container_ids)),
    'container_first', (SELECT c.container_no FROM public.containers c WHERE c.id = ANY (r.container_ids) ORDER BY c.container_no LIMIT 1),
    'container_count', cardinality(r.container_ids)::text,
    'current_deadline', to_char(r.current_deadline, 'YYYY-MM-DD'),
    'requested_days', r.requested_days::text,
    'requested_until', to_char(r.requested_until, 'YYYY-MM-DD'),
    'org_name', o.name_ar || coalesce(' / ' || nullif(o.name_en, ''), ''),
    'signature', coalesce((SELECT nullif(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = auth.uid()) || E'\n', '')
                 || o.name_ar || coalesce(' / ' || nullif(o.name_en, ''), ''),
    'today', to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD'))
    FROM public.transactions t JOIN public.organizations o ON o.id = t.org_id
    LEFT JOIN public.parties pa ON pa.id = r.agent_party_id
   WHERE t.id = r.transaction_id
$$;
-- {subject, body} of a request with the org template
CREATE OR REPLACE FUNCTION app.rx_text(r public.return_extension_requests) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb := app.rx_vars(r); tpl jsonb := app.rx_template(r.org_id);
BEGIN
  RETURN jsonb_build_object('subject', left(regexp_replace(app.rx_render(tpl ->> 'subject', v), '[\r\n]+', ' ', 'g'), 300),
                            'body', left(app.rx_render(tpl ->> 'body', v), 8000));
END $$;

-- ---------------------------------------------------------------------
-- 4. event type + labels
-- ---------------------------------------------------------------------
ALTER TABLE public.transaction_events DROP CONSTRAINT IF EXISTS transaction_events_event_type_check;
ALTER TABLE public.transaction_events ADD CONSTRAINT transaction_events_event_type_check CHECK (event_type IN
  ('created','request_converted','operational_status','financial_status','container_return','document','note','tracking_token',
   -- G3 (A): declarations, B/L links, container operational state
   'declaration','bl','container',
   -- G3 (B): appointments, transport trips, operational exceptions, document-requirement overrides
   'appointment','trip','exception','docs_override',
   -- G4: finance (internal; payload {op, entity, id, …ids}, never amounts)
   'finance',
   -- G5: billing / Daftra sync (internal; payload {op, entity, id, …ids}, never amounts nor bodies)
   'billing',
   -- G6b: inbox (internal; payload {op, thread_id, …ids})
   'message',
   -- 20261127000100: draft transaction approved
   'tx_approval',
   -- 20261128000100: empty-return extension request (internal; payload {op, request_id, container_ids, …dates}, never the text)
   'return_extension'));

INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('audit_event','return_extension',20,'طلب تمديد مهلة إرجاع الفارغ','Empty-return extension request',false),
  ('alert_kind','empty_return_no_deadline',10,'حاوية بلا موعد إرجاع','Container without a return deadline',false),
  ('return_extension_status','draft',1,'جاهز للإرسال','Ready to send',false),
  ('return_extension_status','sent',2,'مُرسَل بانتظار رد الوكيل','Sent, awaiting the agent',false),
  ('return_extension_status','approved',3,'وافق الوكيل','Approved by the agent',false),
  ('return_extension_status','partially_approved',4,'وافق جزئيًا','Partially approved',false),
  ('return_extension_status','rejected',5,'رفض الوكيل','Rejected by the agent',false),
  ('return_extension_status','cancelled',6,'ملغى','Cancelled',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, client_visible = EXCLUDED.client_visible;

-- the new alert kind (the 20261124000100 CHECK, re-created as a superset)
ALTER TABLE public.operational_alerts DROP CONSTRAINT IF EXISTS operational_alerts_kind_check;
ALTER TABLE public.operational_alerts ADD CONSTRAINT operational_alerts_kind_check
  CHECK (kind IN ('docs_missing','appointment_soon','appointment_missed','empty_return_due','empty_return_overdue','exception_open',
                  'declaration_stalled','status_stale','appointment_not_updated',
                  'empty_return_no_deadline'));

-- ---------------------------------------------------------------------
-- 5. alert causes (20261125000100, re-created): RX — the lead time of the org + the extension state in the title + no deadline
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.alert_causes(p_org uuid, p_now timestamptz)
RETURNS TABLE (dedupe_key text, kind text, severity text, branch_id uuid, transaction_id uuid, container_id uuid,
               subject_id uuid, title_ar text, title_en text, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT z.* FROM (
  WITH today AS (SELECT (p_now AT TIME ZONE 'Asia/Riyadh')::date AS d,
                        (app.empty_return_rules(p_org) ->> 'lead_days')::int AS lead_days),                  -- RX
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
  -- RX: the lead time of the org (empty_return_rules.lead_days, default 3) + what to do next in the title: request an extension
  -- from the shipping agent, or the open request (a draft not sent yet / sent, awaiting the agent). A request never silences the
  -- alert: the deadline is real until the agent's answer is recorded (decide_return_extension moves it).
  SELECT CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue:' ELSE 'empty_return_due:' END || c.id,
         CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue' ELSE 'empty_return_due' END,
         CASE WHEN c.return_deadline < today.d THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, c.id, c.id,
         CASE WHEN c.return_deadline < today.d THEN 'تأخر إرجاع الحاوية الفارغة ' ELSE 'موعد إرجاع الحاوية الفارغة قريب ' END
           || c.container_no || ' — ' || t.ref
           || CASE rx.status WHEN 'sent' THEN ' — طلب التمديد مُرسَل بانتظار رد الوكيل الملاحي'
                             WHEN 'draft' THEN ' — طلب التمديد جاهز ولم يُرسَل بعد'
                             ELSE ' — اطلب تمديدًا من الوكيل الملاحي' END,
         CASE WHEN c.return_deadline < today.d THEN 'Empty return overdue ' ELSE 'Empty return due ' END
           || c.container_no || ' — ' || t.ref
           || CASE rx.status WHEN 'sent' THEN ' — extension requested, awaiting the shipping agent'
                             WHEN 'draft' THEN ' — extension request prepared, not sent yet'
                             ELSE ' — request an extension from the shipping agent' END,
         ((c.return_deadline + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')
    FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id CROSS JOIN today
    LEFT JOIN LATERAL (SELECT r.status FROM public.return_extension_requests r
                        WHERE r.transaction_id = c.transaction_id AND r.status IN ('draft','sent') AND c.id = ANY (r.container_ids)
                        ORDER BY (r.status = 'sent') DESC, r.created_at DESC LIMIT 1) rx ON true
   WHERE c.org_id = p_org AND c.return_status IN ('pending','evidence_submitted','disputed') AND t.cancelled_at IS NULL
     AND c.return_deadline IS NOT NULL AND c.return_deadline <= today.d + today.lead_days
  UNION ALL
  -- RX: a container that left the port (gate-out) with no empty-return deadline: no deadline, no warning — ask for one
  SELECT 'empty_return_no_deadline:' || c.id, 'empty_return_no_deadline', 'warning', t.branch_id, t.id, c.id, c.id,
         'حاوية خرجت من الميناء بلا موعد إرجاع للفارغ ' || c.container_no || ' — ' || t.ref || ' — أدخل الموعد من إيصال الخروج (EIR)',
         'Container gated out without an empty-return deadline ' || c.container_no || ' — ' || t.ref || ' — enter the deadline from the EIR',
         NULL::timestamptz
    FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
   WHERE c.org_id = p_org AND c.return_status = 'pending' AND t.cancelled_at IS NULL
     AND c.gate_out_at IS NOT NULL AND c.return_deadline IS NULL AND c.returned_at IS NULL
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
  ) z (dedupe_key, kind, severity, branch_id, transaction_id, container_id, subject_id, title_ar, title_en, due_at)
  -- LI: no alert for an imported billed / closed transaction
   WHERE NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = z.transaction_id AND app.li_quiet_tx(t.import_run_id, t.operational_status))
$$;

-- ---------------------------------------------------------------------
-- 6. RPCs
-- ---------------------------------------------------------------------
-- a jsonb array of uuid strings → uuid[] (distinct, NULL when the key is absent / null); MRS_INVALID <k> when malformed / > 200
CREATE OR REPLACE FUNCTION app.rx_uuid_list(p jsonb, k text) RETURNS uuid[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v uuid[];
BEGIN
  IF p IS NULL OR NOT (p ? k) OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'array' OR jsonb_array_length(p -> k) NOT BETWEEN 1 AND 200
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p -> k) e
                 WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    PERFORM app.fail('MRS_INVALID', k);
  END IF;
  SELECT array_agg(DISTINCT (e #>> '{}')::uuid) INTO v FROM jsonb_array_elements(p -> k) e;
  RETURN v;
END $$;

-- the containers of a request: each a container of the transaction (MRS_INVALID container_ids), still open (a returned / waived
-- one → MRS_INVALID container_ids) with a deadline (MRS_REQUIRED return_deadline); NULL = the default choice (the open containers
-- whose deadline is within the lead time or past, else every open container with a deadline). → ids ordered by container number
CREATE OR REPLACE FUNCTION app.rx_pick_containers(p_tx public.transactions, p_ids uuid[]) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid[]; v_today date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
        v_lead int := (app.empty_return_rules(p_tx.org_id) ->> 'lead_days')::int;
BEGIN
  IF p_ids IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(p_ids) x WHERE NOT EXISTS (SELECT 1 FROM public.containers c WHERE c.id = x AND c.transaction_id = p_tx.id))
       OR EXISTS (SELECT 1 FROM public.containers c WHERE c.id = ANY (p_ids) AND NOT (c.return_status = ANY (app.rpt_open_returns()))) THEN
      PERFORM app.fail('MRS_INVALID', 'container_ids');
    END IF;
    IF EXISTS (SELECT 1 FROM public.containers c WHERE c.id = ANY (p_ids) AND c.return_deadline IS NULL) THEN
      PERFORM app.fail('MRS_REQUIRED', 'return_deadline');
    END IF;
    SELECT array_agg(c.id ORDER BY c.container_no, c.id) INTO v FROM public.containers c WHERE c.id = ANY (p_ids);
    RETURN v;
  END IF;
  SELECT array_agg(c.id ORDER BY c.container_no, c.id) INTO v FROM public.containers c
   WHERE c.transaction_id = p_tx.id AND c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline IS NOT NULL
     AND c.return_deadline <= v_today + v_lead;
  IF v IS NULL THEN
    SELECT array_agg(c.id ORDER BY c.container_no, c.id) INTO v FROM public.containers c
     WHERE c.transaction_id = p_tx.id AND c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline IS NOT NULL;
  END IF;
  IF v IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = p_tx.id AND c.return_status = ANY (app.rpt_open_returns())) THEN
      PERFORM app.fail('MRS_REQUIRED', 'return_deadline');
    END IF;
    PERFORM app.fail('MRS_REQUIRED', 'container_ids');
  END IF;
  RETURN v;
END $$;

-- requested days / date against a current deadline: requested_until wins (1..60 days later), else requested_days (1..60), else
-- p_default. Both given and not consistent → MRS_INVALID requested_until. → (days, until)
CREATE OR REPLACE FUNCTION app.rx_period(p jsonb, p_current date, p_default int, OUT out_days int, OUT out_until date)
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_d numeric; v_u date;
BEGIN
  v_u := app.pdate(p, 'requested_until');
  IF p ? 'requested_days' AND jsonb_typeof(p -> 'requested_days') <> 'null' THEN
    IF jsonb_typeof(p -> 'requested_days') NOT IN ('number','string') THEN PERFORM app.fail('MRS_INVALID', 'requested_days'); END IF;
    v_d := app.pnum(p, 'requested_days', 60);
    IF v_d IS NULL OR v_d <> trunc(v_d) OR v_d < 1 THEN PERFORM app.fail('MRS_INVALID', 'requested_days'); END IF;
  END IF;
  IF v_u IS NOT NULL THEN
    IF v_u - p_current NOT BETWEEN 1 AND 60 OR (v_d IS NOT NULL AND v_u - p_current <> v_d) THEN
      PERFORM app.fail('MRS_INVALID', 'requested_until');
    END IF;
    out_days := v_u - p_current; out_until := v_u;
  ELSE
    out_days := coalesce(v_d::int, p_default); out_until := p_current + out_days;
  END IF;
END $$;

-- an e-mail address (the parties.email rule) → lower-case, or MRS_INVALID to_address
CREATE OR REPLACE FUNCTION app.rx_email(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := lower(nullif(btrim(coalesce(p, '')), ''));
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF char_length(v) > 160 OR v !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' THEN PERFORM app.fail('MRS_INVALID', 'to_address'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.rx_json(r public.return_extension_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', r.id, 'org_id', r.org_id, 'transaction_id', r.transaction_id, 'ref', t.ref,
    'bl_id', r.bl_id, 'bl_number', (SELECT b.bl_number FROM public.bills_of_lading b WHERE b.id = r.bl_id),
    'agent_party_id', r.agent_party_id, 'agent_name', pa.name_ar, 'agent_name_en', pa.name_en, 'agent_email', pa.email,
    'container_ids', to_jsonb(r.container_ids),
    'containers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'container_no', c.container_no, 'return_deadline', c.return_deadline,
                                                                'return_status', c.return_status) ORDER BY c.container_no)
                              FROM public.containers c WHERE c.id = ANY (r.container_ids)), '[]'::jsonb),
    'current_deadline', r.current_deadline, 'requested_days', r.requested_days, 'requested_until', r.requested_until,
    'to_address', r.to_address, 'subject', r.subject, 'body', r.body, 'text_edited', r.text_edited, 'status', r.status,
    'sent_at', r.sent_at, 'sent_by', r.sent_by, 'sent_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = r.sent_by),
    'sent_note', r.sent_note, 'decided_until', r.decided_until, 'decision_note', r.decision_note,
    'decision_document_id', r.decision_document_id, 'decided_at', r.decided_at, 'decided_by', r.decided_by,
    'decided_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = r.decided_by),
    'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason, 'exception_id', r.exception_id, 'msg_thread_id', r.msg_thread_id,
    'created_by', r.created_by, 'created_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = r.created_by),
    'created_at', r.created_at, 'updated_at', r.updated_at)
    FROM public.transactions t LEFT JOIN public.parties pa ON pa.id = r.agent_party_id
   WHERE t.id = r.transaction_id
$$;

CREATE OR REPLACE FUNCTION app.rx_event(r public.return_extension_requests, p_op text, p_extra jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, to_status, visible_to_client, actor, payload)
  SELECT r.org_id, r.transaction_id, 'return_extension', t.operational_status, false, auth.uid(),
         jsonb_build_object('op', p_op, 'request_id', r.id, 'status', r.status, 'container_ids', to_jsonb(r.container_ids),
                            'requested_until', r.requested_until, 'decided_until', r.decided_until) || coalesce(p_extra, '{}'::jsonb)
    FROM public.transactions t WHERE t.id = r.transaction_id;
END $$;

-- a request + the transaction lock for a write (transport writers of the branch; a cancelled transaction → MRS_BAD_TRANSITION)
CREATE OR REPLACE FUNCTION app.rx_lock(p_id uuid) RETURNS public.return_extension_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.return_extension_requests;
BEGIN
  SELECT * INTO r FROM public.return_extension_requests x WHERE x.id = p_id;
  IF r.id IS NULL OR NOT app.has_tx_role(r.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'request'); END IF;
  PERFORM app.g3_lock_tx(r.transaction_id, app.transport_writer_roles());
  SELECT * INTO r FROM public.return_extension_requests x WHERE x.id = p_id FOR UPDATE;
  RETURN r;
END $$;

-- close the linked detention_extension exception (resolved, with the note) when it is still open
CREATE OR REPLACE FUNCTION app.rx_close_exception(p_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.operational_exceptions; v_from text;
BEGIN
  SELECT * INTO e FROM public.operational_exceptions x WHERE x.id = p_id FOR UPDATE;
  IF e.id IS NULL OR e.status NOT IN ('open','in_progress') THEN RETURN; END IF;
  v_from := e.status;
  UPDATE public.operational_exceptions x SET status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
         resolution_note = left(p_note, 2000), updated_at = now()
   WHERE x.id = e.id RETURNING * INTO e;
  PERFORM app.exc_event(e, 'status', v_from, p_note);
END $$;

-- prepare_return_extension(p_tx, {container_ids?, bl_id?, agent_party_id?, requested_days? | requested_until?, to_address?,
--   idempotencyKey?}) — a DRAFT extension request: the containers (default: due within the lead time / overdue), the shipping
-- agent of the B/L (several agents → MRS_REQUIRED bl_id), its e-mail (none → to_address NULL + missing_email true), the text
-- rendered from the org template, and a detention_extension exception (in_progress). Nothing is sent. Transport writers.
CREATE OR REPLACE FUNCTION public.prepare_return_extension(p_tx uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_tx public.transactions; v_key uuid; v_replay jsonb; v_ids uuid[]; v_rules jsonb;
  v_bl uuid; v_agent uuid; v_ag2 uuid; v_n int; v_cur date; v_per record; v_to text; r public.return_extension_requests;
  e public.operational_exceptions; v_txt jsonb; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  PERFORM app.only_keys(p, ARRAY['container_ids','bl_id','agent_party_id','requested_days','requested_until','to_address','idempotencyKey']);
  v_tx := app.g3_lock_tx(p_tx, app.transport_writer_roles());
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('prepare_return_extension', v_key, jsonb_build_object('transaction', v_tx.id, 'p', p - 'idempotencyKey'), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_rules := app.empty_return_rules(v_tx.org_id);
  v_ids := app.rx_pick_containers(v_tx, app.rx_uuid_list(p, 'container_ids'));
  IF EXISTS (SELECT 1 FROM public.return_extension_requests x WHERE x.transaction_id = v_tx.id AND x.status IN ('draft','sent')
                AND x.container_ids && v_ids) THEN
    PERFORM app.fail('MRS_RX_EXISTS', 'container');
  END IF;
  -- the shipping agent: of the chosen B/L, else the one agent of the transaction's B/Ls (primary first); an explicit agent wins
  v_bl := app.puuid(p, 'bl_id');
  v_ag2 := app.puuid(p, 'agent_party_id');
  IF v_bl IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id AND tb.bl_id = v_bl) THEN
      PERFORM app.fail('MRS_INVALID', 'bl_id');
    END IF;
    SELECT b.shipping_agent_id INTO v_agent FROM public.bills_of_lading b WHERE b.id = v_bl;
  ELSE
    SELECT count(DISTINCT b.shipping_agent_id)::int INTO v_n FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
     WHERE tb.transaction_id = v_tx.id AND b.shipping_agent_id IS NOT NULL;
    IF v_n > 1 AND v_ag2 IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'bl_id'); END IF;
    -- an explicit agent takes its own B/L when it has one (the subject / body name that B/L), never another agent's
    SELECT tb.bl_id, b.shipping_agent_id INTO v_bl, v_agent FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
     WHERE tb.transaction_id = v_tx.id
       AND (v_ag2 IS NULL OR v_n <= 1 OR b.shipping_agent_id = v_ag2 OR b.shipping_agent_id IS NULL)
     ORDER BY (v_ag2 IS NOT NULL AND b.shipping_agent_id = v_ag2) DESC, (b.shipping_agent_id IS NOT NULL) DESC, tb.is_primary DESC,
              tb.created_at, tb.bl_id LIMIT 1;
  END IF;
  IF v_ag2 IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id = v_ag2 AND pa.org_id = v_tx.org_id AND pa.is_active
                      AND 'shipping_agent' = ANY (pa.kinds)) THEN
      PERFORM app.fail('MRS_INVALID', 'agent_party_id');
    END IF;
    v_agent := v_ag2;
  END IF;
  IF EXISTS (SELECT 1 FROM public.return_extension_requests x WHERE x.transaction_id = v_tx.id AND x.status IN ('draft','sent')
                AND x.agent_party_id IS NOT DISTINCT FROM v_agent) THEN
    PERFORM app.fail('MRS_RX_EXISTS', 'agent');
  END IF;
  SELECT min(c.return_deadline) INTO v_cur FROM public.containers c WHERE c.id = ANY (v_ids);
  SELECT * INTO v_per FROM app.rx_period(p, v_cur, (v_rules ->> 'default_request_days')::int);
  v_to := app.rx_email(app.ptext(p, 'to_address', 200));
  IF v_to IS NULL AND v_agent IS NOT NULL THEN
    SELECT lower(pa.email) INTO v_to FROM public.parties pa WHERE pa.id = v_agent;
  END IF;

  e := app.exc_insert(v_tx, 'detention_extension', 'manual',
         'طلب تمديد مهلة إرجاع الحاويات الفارغة حتى ' || to_char(v_per.out_until, 'YYYY-MM-DD') || ' — ' || cardinality(v_ids) || ' حاوية',
         CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1] END, NULL, NULL, NULL, NULL, now());
  UPDATE public.operational_exceptions x SET status = 'in_progress', updated_at = now() WHERE x.id = e.id RETURNING * INTO e;
  PERFORM app.exc_event(e, 'status', 'open', NULL);

  r.id := gen_random_uuid(); r.org_id := v_tx.org_id; r.transaction_id := v_tx.id; r.bl_id := v_bl; r.agent_party_id := v_agent;
  r.container_ids := v_ids; r.current_deadline := v_cur; r.requested_days := v_per.out_days; r.requested_until := v_per.out_until;
  v_txt := app.rx_text(r);
  INSERT INTO public.return_extension_requests (id, org_id, transaction_id, bl_id, agent_party_id, container_ids, current_deadline,
                                                requested_days, requested_until, to_address, subject, body, exception_id, created_by)
  VALUES (r.id, r.org_id, r.transaction_id, r.bl_id, r.agent_party_id, r.container_ids, r.current_deadline, r.requested_days,
          r.requested_until, v_to, v_txt ->> 'subject', v_txt ->> 'body', e.id, auth.uid())
  RETURNING * INTO r;
  PERFORM app.rx_event(r, 'prepared', NULL);
  v_res := app.rx_json(r) || jsonb_build_object('missing_email', r.to_address IS NULL, 'lead_days', (v_rules ->> 'lead_days')::int);
  RETURN app.idem_finish('prepare_return_extension', v_key, v_res);
END $$;

-- update_return_extension(p_id, {container_ids?, requested_days? | requested_until?, to_address? (null clears), subject?, body?,
--   rerender?}) — a DRAFT only. Changing the containers / days re-renders the text unless the user edited it (rerender: true resets
--   the text to the template).
CREATE OR REPLACE FUNCTION public.update_return_extension(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); r public.return_extension_requests; v_tx public.transactions; v_ids uuid[];
  v_per record; v_txt jsonb; v_subj text; v_body text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  PERFORM app.only_keys(p, ARRAY['container_ids','requested_days','requested_until','to_address','subject','body','rerender']);
  r := app.rx_lock(p_id);
  IF r.status <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', r.status); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = r.transaction_id;
  v_ids := app.rx_uuid_list(p, 'container_ids');
  IF v_ids IS NOT NULL THEN
    v_ids := app.rx_pick_containers(v_tx, v_ids);
    IF EXISTS (SELECT 1 FROM public.return_extension_requests x WHERE x.transaction_id = r.transaction_id AND x.id <> r.id
                  AND x.status IN ('draft','sent') AND x.container_ids && v_ids) THEN
      PERFORM app.fail('MRS_RX_EXISTS', 'container');
    END IF;
    r.container_ids := v_ids;
    SELECT min(c.return_deadline) INTO r.current_deadline FROM public.containers c WHERE c.id = ANY (v_ids);
  END IF;
  SELECT * INTO v_per FROM app.rx_period(p, r.current_deadline, r.requested_days);
  r.requested_days := v_per.out_days; r.requested_until := v_per.out_until;
  IF p ? 'to_address' THEN r.to_address := app.rx_email(app.ptext(p, 'to_address', 200)); END IF;
  v_subj := app.ptext(p, 'subject', 300);
  IF p ? 'body' THEN
    IF jsonb_typeof(p -> 'body') <> 'string' THEN PERFORM app.fail('MRS_INVALID', 'body'); END IF;
    v_body := nullif(btrim(p ->> 'body'), '');
    IF char_length(v_body) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'body'); END IF;
  END IF;
  IF (p ? 'subject' AND v_subj IS NULL) OR (p ? 'body' AND v_body IS NULL) THEN
    PERFORM app.fail('MRS_REQUIRED', CASE WHEN p ? 'subject' AND v_subj IS NULL THEN 'subject' ELSE 'body' END);
  END IF;
  v_txt := app.rx_text(r);
  IF coalesce(app.pbool(p, 'rerender'), false) THEN
    r.subject := v_txt ->> 'subject'; r.body := v_txt ->> 'body'; r.text_edited := false;
  ELSIF v_subj IS NOT NULL OR v_body IS NOT NULL THEN
    r.subject := coalesce(regexp_replace(v_subj, '[\r\n]+', ' ', 'g'), CASE WHEN r.text_edited THEN r.subject ELSE v_txt ->> 'subject' END);
    r.body := coalesce(v_body, CASE WHEN r.text_edited THEN r.body ELSE v_txt ->> 'body' END);
    r.text_edited := r.text_edited OR r.subject IS DISTINCT FROM (v_txt ->> 'subject') OR r.body IS DISTINCT FROM (v_txt ->> 'body');
  ELSIF NOT r.text_edited THEN
    r.subject := v_txt ->> 'subject'; r.body := v_txt ->> 'body';
  END IF;
  UPDATE public.return_extension_requests x SET container_ids = r.container_ids, current_deadline = r.current_deadline,
         requested_days = r.requested_days, requested_until = r.requested_until, to_address = r.to_address, subject = r.subject,
         body = r.body, text_edited = r.text_edited
   WHERE x.id = r.id RETURNING * INTO r;
  PERFORM app.rx_event(r, 'updated', NULL);
  RETURN app.rx_json(r) || jsonb_build_object('missing_email', r.to_address IS NULL);
END $$;

-- mark_return_extension_sent(p_id, p_note) — the user's statement that THEY sent the e-mail from their own mail program
-- («تم الإرسال»); the program sends nothing. A draft with a recipient (MRS_REQUIRED to_address) → sent.
CREATE OR REPLACE FUNCTION public.mark_return_extension_sent(p_id uuid, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.return_extension_requests; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  r := app.rx_lock(p_id);
  IF r.status <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', r.status); END IF;
  IF r.to_address IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'to_address'); END IF;
  IF char_length(v_note) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  UPDATE public.return_extension_requests x SET status = 'sent', sent_at = now(), sent_by = auth.uid(), sent_note = v_note
   WHERE x.id = r.id RETURNING * INTO r;
  PERFORM app.rx_event(r, 'sent', NULL);
  RETURN app.rx_json(r);
END $$;

-- decide_return_extension(p_id, {outcome approved | partially_approved | rejected, decided_until (approved / partial: after the
--   current deadline, ≤ 365 days), note (required for rejected and for a draft answered by phone), container_ids? (partial: a subset),
--   msg_thread_id? (an inbox thread of the transaction), document_id? (the agent's letter, a document of the transaction),
--   idempotencyKey?}) — the agent's answer. Approved: return_deadline of each still-open container of the request moves to
--   decided_until through public.set_container_return (never earlier than its own deadline; returned / waived containers are
--   skipped); the exception is resolved. Rejected: deadlines unchanged (the alert goes on), the exception is resolved with the note.
--   demurrage_cases are not touched (demurrage_hint when an open detention case exists).
CREATE OR REPLACE FUNCTION public.decide_return_extension(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); r public.return_extension_requests; v_key uuid; v_replay jsonb; v_out text;
  v_until date; v_note text; v_thread uuid; v_doc uuid; v_ids uuid[]; c record; v_upd jsonb := '[]'::jsonb; v_skip jsonb := '[]'::jsonb;
  v_same jsonb := '[]'::jsonb; v_hint boolean; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payload'); END IF;
  PERFORM app.only_keys(p, ARRAY['outcome','decided_until','note','container_ids','msg_thread_id','document_id','idempotencyKey']);
  r := app.rx_lock(p_id);
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('decide_return_extension', v_key, jsonb_build_object('request', r.id, 'p', p - 'idempotencyKey'), r.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF r.status NOT IN ('draft','sent') THEN PERFORM app.fail('MRS_BAD_TRANSITION', r.status); END IF;
  v_out := app.ptext(p, 'outcome', 30);
  IF v_out IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'outcome'); END IF;
  IF v_out NOT IN ('approved','partially_approved','rejected') THEN PERFORM app.fail('MRS_INVALID', 'outcome'); END IF;
  v_note := app.ptext(p, 'note', 1000);
  IF v_note IS NULL AND (v_out = 'rejected' OR r.status = 'draft') THEN PERFORM app.fail('MRS_REQUIRED', 'note'); END IF;
  v_until := app.pdate(p, 'decided_until');
  IF v_out = 'rejected' THEN
    IF v_until IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'decided_until'); END IF;
  ELSE
    IF v_until IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'decided_until'); END IF;
    IF v_until <= r.current_deadline OR v_until > r.current_deadline + 365 THEN PERFORM app.fail('MRS_INVALID', 'decided_until'); END IF;
  END IF;
  v_ids := app.rx_uuid_list(p, 'container_ids');
  IF v_ids IS NOT NULL AND (v_out <> 'partially_approved' OR NOT (v_ids <@ r.container_ids)) THEN
    PERFORM app.fail('MRS_INVALID', 'container_ids');
  END IF;
  v_thread := app.puuid(p, 'msg_thread_id');
  IF v_thread IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.msg_threads th WHERE th.id = v_thread AND th.org_id = r.org_id
                                             AND th.transaction_id = r.transaction_id) THEN
    PERFORM app.fail('MRS_INVALID', 'msg_thread_id');
  END IF;
  v_doc := app.puuid(p, 'document_id');
  PERFORM app.g3_check_document(r.transaction_id, v_doc, 'document_id');

  IF v_out <> 'rejected' THEN
    FOR c IN SELECT x.id, x.container_no, x.return_status, x.return_deadline FROM public.containers x
              WHERE x.id = ANY (coalesce(v_ids, r.container_ids)) ORDER BY x.container_no, x.id LOOP
      IF NOT (c.return_status = ANY (app.rpt_open_returns())) THEN
        v_skip := v_skip || jsonb_build_object('id', c.id, 'container_no', c.container_no, 'return_status', c.return_status);
      ELSIF c.return_deadline IS NOT NULL AND c.return_deadline >= v_until THEN
        v_same := v_same || jsonb_build_object('id', c.id, 'container_no', c.container_no, 'return_deadline', c.return_deadline);
      ELSE
        PERFORM public.set_container_return(c.id, jsonb_build_object('return_deadline', to_char(v_until, 'YYYY-MM-DD')));
        v_upd := v_upd || jsonb_build_object('id', c.id, 'container_no', c.container_no, 'from', c.return_deadline, 'to', v_until);
      END IF;
    END LOOP;
  END IF;
  UPDATE public.return_extension_requests x SET status = v_out, decided_until = CASE WHEN v_out = 'rejected' THEN NULL ELSE v_until END,
         decision_note = v_note, decision_document_id = v_doc, decided_at = now(), decided_by = auth.uid(),
         msg_thread_id = coalesce(v_thread, x.msg_thread_id)
   WHERE x.id = r.id RETURNING * INTO r;
  PERFORM app.rx_close_exception(r.exception_id,
    CASE v_out WHEN 'rejected' THEN 'رفض الوكيل الملاحي طلب التمديد'
               WHEN 'partially_approved' THEN 'وافق الوكيل الملاحي جزئيًا على التمديد حتى ' || to_char(v_until, 'YYYY-MM-DD')
               ELSE 'وافق الوكيل الملاحي على التمديد حتى ' || to_char(v_until, 'YYYY-MM-DD') END || coalesce(' — ' || v_note, ''));
  PERFORM app.rx_event(r, 'decided', jsonb_build_object('outcome', v_out, 'updated', jsonb_array_length(v_upd),
                                                         'skipped', jsonb_array_length(v_skip)));
  v_hint := EXISTS (SELECT 1 FROM public.demurrage_cases d WHERE d.transaction_id = r.transaction_id AND d.kind = 'detention'
                       AND d.status = 'open' AND (d.container_id IS NULL OR d.container_id = ANY (r.container_ids)));
  v_res := app.rx_json(r) || jsonb_build_object('updated', v_upd, 'skipped', v_skip, 'unchanged', v_same, 'demurrage_hint', v_hint);
  RETURN app.idem_finish('decide_return_extension', v_key, v_res);
END $$;

-- cancel_return_extension(p_id, p_reason) — a draft or sent request → cancelled (reason required); the exception is resolved
CREATE OR REPLACE FUNCTION public.cancel_return_extension(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.return_extension_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  r := app.rx_lock(p_id);
  IF r.status NOT IN ('draft','sent') THEN PERFORM app.fail('MRS_BAD_TRANSITION', r.status); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.return_extension_requests x SET status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
   WHERE x.id = r.id RETURNING * INTO r;
  PERFORM app.rx_close_exception(r.exception_id, 'أُلغي طلب التمديد — ' || v_reason);
  PERFORM app.rx_event(r, 'cancelled', NULL);
  RETURN app.rx_json(r);
END $$;

-- list_return_extensions(p_org, {transaction_id?, status? (one of the statuses | 'active' = draft + sent), limit ≤ 200}) — staff;
-- the rows of the branches the caller may read. → {items [...], total, counts {draft, sent}}
CREATE OR REPLACE FUNCTION public.list_return_extensions(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_tx uuid; v_st text; v_lim numeric;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(f, ARRAY['transaction_id','status','limit']);
  PERFORM app.rpt_gate_staff(p_org);
  v_tx := app.puuid(f, 'transaction_id');
  IF v_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = v_tx AND t.org_id = p_org
                                         AND app.has_tx_role(t.id, app.staff_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;
  v_st := app.ptext(f, 'status', 30);
  IF v_st IS NOT NULL AND v_st <> 'active' AND NOT app.is_code('return_extension_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_lim := coalesce(app.pnum(f, 'limit', 200), 100);
  RETURN (
    WITH s AS (
      SELECT r.* FROM public.return_extension_requests r
       WHERE r.org_id = p_org AND (v_tx IS NULL OR r.transaction_id = v_tx)
         AND (v_st IS NULL OR r.status = v_st OR (v_st = 'active' AND r.status IN ('draft','sent')))
         AND app.has_tx_role(r.transaction_id, app.staff_roles()))
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(app.rx_json(z) ORDER BY z.created_at DESC, z.id)
                           FROM (SELECT * FROM s ORDER BY s.created_at DESC, s.id LIMIT v_lim::int) z), '[]'::jsonb),
      'total', (SELECT count(*)::int FROM s),
      'counts', jsonb_build_object('draft', (SELECT count(*)::int FROM s WHERE s.status = 'draft'),
                                   'sent', (SELECT count(*)::int FROM s WHERE s.status = 'sent'))));
END $$;

-- get_empty_return_rules(p_org) — staff: {rules (in force), defaults, overrides (stored), template {subject, body, custom},
--   builtin {subject, body}, placeholders, can_edit}
CREATE OR REPLACE FUNCTION public.get_empty_return_rules(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_set jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.rpt_gate_staff(p_org);
  SELECT o.settings INTO v_set FROM public.organizations o WHERE o.id = p_org;
  RETURN jsonb_build_object('rules', app.empty_return_rules(p_org), 'defaults', app.empty_return_rules_defaults(),
    'overrides', CASE WHEN jsonb_typeof(v_set -> 'empty_return_rules') = 'object' THEN v_set -> 'empty_return_rules' ELSE '{}'::jsonb END,
    'template', app.rx_template(p_org), 'builtin', app.rx_builtin_template(), 'placeholders', to_jsonb(app.rx_placeholders()),
    'can_edit', app.has_role(p_org, ARRAY['admin']) AND app.rpt_scope(p_org, ARRAY['admin']) IS NULL);
END $$;

-- set_empty_return_rules(p_org, p_rules, p_reason) — the org owner (org-wide admin, aal2): {lead_days?, default_request_days?}
-- (whole numbers 1..30) replaces the stored overrides ({} = back to the defaults); reason required (≤ 500). → get_empty_return_rules
CREATE OR REPLACE FUNCTION public.set_empty_return_rules(p_org uuid, p_rules jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) OR app.rpt_scope(p_org, ARRAY['admin']) IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
  END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  PERFORM app.empty_return_rules_check(coalesce(p_rules, '{}'::jsonb));
  UPDATE public.organizations o
     SET settings = jsonb_set(coalesce(o.settings, '{}'::jsonb), '{empty_return_rules}', coalesce(p_rules, '{}'::jsonb))
                    || jsonb_build_object('empty_return_rules_reason', left(v_reason, 500))
   WHERE o.id = p_org;
  RETURN public.get_empty_return_rules(p_org);
END $$;

-- set_return_extension_template(p_org, p_tpl {subject ≤ 300, body ≤ 8000} | null / {} (back to the built-in text), p_reason) — the
-- org owner; only the known {{placeholders}} (MRS_INVALID placeholder). → get_empty_return_rules
CREATE OR REPLACE FUNCTION public.set_return_extension_template(p_org uuid, p_tpl jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_s text; v_b text; t jsonb := coalesce(p_tpl, '{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) OR app.rpt_scope(p_org, ARRAY['admin']) IS NOT NULL THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
  END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  IF jsonb_typeof(t) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'template'); END IF;
  PERFORM app.only_keys(t, ARRAY['subject','body']);
  IF t = '{}'::jsonb THEN
    UPDATE public.organizations o SET settings = (coalesce(o.settings, '{}'::jsonb) - 'return_extension_template')
                                                 || jsonb_build_object('return_extension_template_reason', left(v_reason, 500))
     WHERE o.id = p_org;
    RETURN public.get_empty_return_rules(p_org);
  END IF;
  v_s := app.ptext(t, 'subject', 300, true);
  IF jsonb_typeof(t -> 'body') IS DISTINCT FROM 'string' OR nullif(btrim(t ->> 'body'), '') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'body'); END IF;
  v_b := btrim(t ->> 'body');
  IF char_length(v_b) > 8000 THEN PERFORM app.fail('MRS_TOO_LONG', 'body'); END IF;
  PERFORM app.rx_placeholders_check(v_s);
  PERFORM app.rx_placeholders_check(v_b);
  UPDATE public.organizations o
     SET settings = jsonb_set(coalesce(o.settings, '{}'::jsonb), '{return_extension_template}', jsonb_build_object('subject', v_s, 'body', v_b))
                    || jsonb_build_object('return_extension_template_reason', left(v_reason, 500))
   WHERE o.id = p_org;
  RETURN public.get_empty_return_rules(p_org);
END $$;

-- ---------------------------------------------------------------------
-- 7. conversion delete list (20261125000100, re-created): + public.return_extension_requests
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
    'public.daftra_runs', 'public.daftra_client_import_rows', 'public.daftra_invoice_candidates',                -- L7
    'public.daftra_supplier_links', 'public.daftra_purchase_drafts',                                              -- L7
    -- inbox (G6b)
    'public.msg_threads', 'public.msg_messages', 'public.msg_message_events', 'public.msg_attachments',
    'public.msg_extractions', 'public.msg_summaries', 'public.msg_classifications', 'public.msg_ai_runs',
    'public.msg_replies', 'public.msg_reply_versions', 'public.msg_reply_approvals', 'public.msg_outbound',
    'public.msg_delivery_events', 'public.msg_jobs', 'public.msg_job_attempts', 'public.msg_thread_links',
    'public.msg_contacts', 'public.msg_contact_addresses', 'public.msg_contact_authorizations', 'public.msg_mock_mailboxes',
    -- legacy import (LI): staged rows, then the runs (transactions.import_run_id points to a run)
    'public.legacy_import_rows', 'public.legacy_import_runs',
    -- RX: empty-return extension requests
    'public.return_extension_requests'
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 8. RLS, policies, grants, function privileges
-- ---------------------------------------------------------------------
ALTER TABLE public.return_extension_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.return_extension_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.return_extension_requests TO authenticated;
DROP POLICY IF EXISTS return_extension_requests_select ON public.return_extension_requests;
CREATE POLICY return_extension_requests_select ON public.return_extension_requests FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));

-- the rules reader is called by app.alert_causes (refresh of every org, cron) and the pure checks are shared: definer code only
REVOKE EXECUTE ON FUNCTION app.empty_return_rules_defaults(), app.empty_return_rules_check(jsonb), app.empty_return_rules(uuid),
  app.rx_placeholders(), app.rx_builtin_template(), app.rx_placeholders_check(text), app.rx_template(uuid), app.rx_render(text, jsonb),
  app.rx_vars(public.return_extension_requests), app.rx_text(public.return_extension_requests), app.rx_uuid_list(jsonb, text),
  app.rx_pick_containers(public.transactions, uuid[]), app.rx_period(jsonb, date, int), app.rx_email(text),
  app.rx_json(public.return_extension_requests), app.rx_event(public.return_extension_requests, text, jsonb), app.rx_lock(uuid),
  app.rx_close_exception(uuid, text), app.tg_return_extension_guard()
FROM PUBLIC, anon, authenticated, service_role;
-- the conversion list stays SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.prepare_return_extension(uuid, jsonb), public.update_return_extension(uuid, jsonb),
  public.mark_return_extension_sent(uuid, text), public.decide_return_extension(uuid, jsonb), public.cancel_return_extension(uuid, text),
  public.list_return_extensions(uuid, jsonb), public.get_empty_return_rules(uuid), public.set_empty_return_rules(uuid, jsonb, text),
  public.set_return_extension_template(uuid, jsonb, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_return_extension(uuid, jsonb), public.update_return_extension(uuid, jsonb),
  public.mark_return_extension_sent(uuid, text), public.decide_return_extension(uuid, jsonb), public.cancel_return_extension(uuid, text),
  public.list_return_extensions(uuid, jsonb), public.get_empty_return_rules(uuid), public.set_empty_return_rules(uuid, jsonb, text),
  public.set_return_extension_template(uuid, jsonb, text)
TO authenticated;
