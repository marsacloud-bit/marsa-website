-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261121000100 — legacy port, step 5: appointment cards and the empty return
-- (بطاقات المواعيد وإعادة الفارغ) — docs/online/LEGACY_APPT_AR.md, plan docs/online/LEGACY_PORT_PLAN_AR.md. Builds on
-- legacy_decl (20261120000100) and reuses step 2 (save_movement, the duplicate-appointment guard, the driver / truck
-- auto-upsert) and step 3 (document readings ai-doc-v3, the bound file hash). Database side of the ai-extract doc types
-- appointment_ticket (TAS card) and empty_return_receipt (EIR).
--   P. preflight (legacy_decl applied, save_movement / approve_declaration_extraction present) + schema_versions row
--   0. dictionaries status_labels: appt_draft_status, appt_card_status, appt_movement_type, transport_party_type,
--                   empty_return_proof_status, empty_return_proof_source
--   1. readings     app.extraction_field_keys + the 16 keys of the two operational readings (appointment_booking_ref,
--                   appointment_ticket_no, appointment_operator, appointment_at, appointment_zone_gate, appointment_barcode,
--                   appointment_movement_type, vehicle_plate, driver_name, driver_phone, appointment_gate_instructions,
--                   driver_license, vehicle_ref_id, vehicle_serial_id, return_delivered_at, return_depot);
--                   app.extraction_detail_ok + the detected types appointment_ticket / appointment_invoice /
--                   empty_return_receipt and the detail objects appointment / empty_return (app.extraction_appt_detail_ok,
--                   app.extraction_eir_detail_ok)
--   2. columns      port_appointments + booking_ref, operator_ticket_no, operator_name (the terminal operator as read /
--                   reviewed), zone_gate, barcode, movement_type (full_exit / empty_entry), source_document_id,
--                   extraction_id; app.movement_json re-created with these and the trip party (list_movements /
--                   save_movement show them); transport_trips + party_type (supplier / company /
--                   direct), party_name, transport_order_no (the per-trip order; the Daftra supplier link and the purchase
--                   draft are step 7)
--   3. tables       public.appointment_drafts (one batch of ≤ 20 cards / 25 MB per transaction: pending → partial →
--                   approved, or cancelled / moved), public.appointment_draft_cards (one card: file hash, reading, staff
--                   review, status pending / approved / skipped / failed / discarded / cancelled, the per-card result,
--                   the movement link), public.empty_return_proofs (the EIR register: pending_review / approved /
--                   unreadable / voided, confidence, match notes, the document ≤ 8 MB). Read under RLS (staff of the
--                   transaction's branch); no write grant; no DELETE; audited without the document content.
--   4. helpers      app.appointment_fingerprint_state(org, sha) (free / pending / approved / released, across the org),
--                   app.appt_ts (a date WITH a time; no offset = Asia/Riyadh), app.appt_review_check, app.appt_card_val,
--                   app.appt_card_json / app.appt_draft_json / app.appt_draft_lock, app.appt_card_approve,
--                   app.erp_json, app.empty_return_blocks_billing (the read-only policy flag: always true in this step),
--                   app.tx_readiness_of; triggers: a cancelled appointment voids its card link, a reschedule moves it to
--                   the new slot, a cancelled transaction cancels its open drafts
--   5. RPCs         appointment_card_state, save_appointment_draft, get_appointment_draft, cancel_appointment_draft,
--                   move_appointment_draft, approve_appointment_draft; create_empty_return_proof, verify_empty_return_proof,
--                   void_empty_return_proof, save_empty_return_deadline, list_empty_return_proofs;
--                   save_transport_carrier_order; tx_readiness
--   6. conversion   app.convert_delete_tables / app.convert_delete_guards re-created with the 3 new tables
--   7. privileges
-- Owner decisions (2026-11-10 / 2026-11-11): billing stays BLOCKED without empty-return proof (set_transaction_status
-- 'under_billing' keeps MRS_CONTAINERS_NOT_RETURNED; empty_return_blocks_billing is a read-only policy flag, true, not
-- switchable by tenants); an EIR reading is NEVER applied automatically (a proof is pending_review until a staff member
-- verifies it; the legacy auto-apply is not ported); a TASTO carrier order does NOT bypass the empty-return proof.
-- Every AI value stays a DRAFT until a staff member approves it; approvals are audited.
-- Errors: + MRS_APPT_DRAFT_EXISTS, MRS_APPT_DRAFT_CLOSED, MRS_APPT_DRAFT_APPROVED, MRS_APPT_DRAFT_STALE, MRS_APPT_DRAFT_LIMIT,
-- MRS_APPT_CARD_DUPLICATE, MRS_APPT_CONTAINER_NOT_IN_TX, MRS_APPT_PARTY_REQUIRED, MRS_DATETIME_REQUIRED,
-- MRS_EMPTY_RETURN_CLOSED, MRS_EMPTY_RETURN_LOCKED, MRS_EMPTY_RETURN_FILE, MRS_TASTO_INVALID, MRS_TASTO_TAKEN, MRS_TASTO_STAGE;
-- otherwise existing codes.
-- Re-runnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS + CREATE /
-- ON CONFLICT). Re-pasting 20261101000100 / 20261114000100 / 20261116000100 / 20261118000100 / 20261119000100 / 20261120000100 after this
-- file narrows the field keys / ai_detail shape (appointment / EIR readings can then not be saved), drops the card fields
-- from app.movement_json (20261118000100) and drops the new tables from the conversion lists: re-paste this file right after.
-- Down-path (staging only): DROP the RPCs of §5 and the app.* helpers / triggers of §4; DROP TABLE
-- public.empty_return_proofs, public.appointment_draft_cards, public.appointment_drafts; DROP the new columns of §2;
-- re-paste 20261120000100 §1 / §6.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261120000100') THEN
    RAISE EXCEPTION 'LEGACY APPT preflight: apply legacy_decl first (schema_versions lacks 20261120000100 legacy_decl)';
  END IF;
  IF to_regprocedure('public.save_movement(jsonb,uuid)') IS NULL
     OR to_regprocedure('public.approve_declaration_extraction(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'LEGACY APPT preflight: public.save_movement / public.approve_declaration_extraction missing (apply 20261118000100 / 20261120000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261121000100', 'legacy_appt')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('appt_draft_status','pending',1,'بانتظار الاعتماد','Pending approval',false),
  ('appt_draft_status','partial',2,'اعتماد جزئي','Partly approved',false),
  ('appt_draft_status','approved',3,'معتمدة','Approved',false),
  ('appt_draft_status','cancelled',4,'ملغاة','Cancelled',false),
  ('appt_draft_status','moved',5,'نُقلت إلى معاملة أخرى','Moved to another transaction',false),
  ('appt_card_status','pending',1,'بانتظار المراجعة','Pending review',false),
  ('appt_card_status','approved',2,'تم الحفظ','Saved',false),
  ('appt_card_status','skipped',3,'ليست بطاقة خروج ممتلئ','Not a full-exit card',false),
  ('appt_card_status','failed',4,'فشل الاعتماد','Approval failed',false),
  ('appt_card_status','discarded',5,'مستبعدة','Discarded',false),
  ('appt_card_status','cancelled',6,'ملغاة','Cancelled',false),
  ('appt_movement_type','full_exit',1,'موعد خروج حاوية ممتلئة','Full container exit',false),
  ('appt_movement_type','empty_entry',2,'موعد دخول حاوية فارغة','Empty container entry',false),
  ('transport_party_type','supplier',1,'مورد','Supplier',false),
  ('transport_party_type','company',2,'شركة نقل','Transport company',false),
  ('transport_party_type','direct',3,'مباشر (السائق)','Direct (the driver)',false),
  ('empty_return_proof_status','pending_review',1,'بانتظار المراجعة','Pending review',false),
  ('empty_return_proof_status','approved',2,'معتمد','Approved',false),
  ('empty_return_proof_status','unreadable',3,'تعذرت القراءة','Unreadable',false),
  ('empty_return_proof_status','voided',4,'ملغى','Voided',false),
  ('empty_return_proof_source','ai',1,'قراءة آلية (Claude)','AI reading (Claude)',false),
  ('empty_return_proof_source','manual',2,'إدخال يدوي','Manual entry',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. readings: the keys and detail of the appointment card / EIR readings (ai-doc-v3)
-- ---------------------------------------------------------------------
-- extraction_field_keys (20261120000100 §1). APPT: + the 16 keys of the two operational readings (= extract.js ALL_KEYS_V3). A superset.
CREATE OR REPLACE FUNCTION app.extraction_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice_number','invoice_date','supplier_name','supplier_vat','buyer_name','buyer_vat',
               'currency','subtotal','vat_amount','total','bl_number','container_numbers',
               'declaration_number','hs_codes','country_of_origin','iban',
               'vessel','voyage','port_of_loading','port_of_discharge','shipper','consignee',
               'gross_weight','net_weight','packages_count','package_type','goods_description','incoterms',
               'seal_numbers','consignee_name','notify_party','booking_number','place_of_receipt',
               'place_of_delivery','freight_terms','measurement_cbm','temperature_c','shipping_line',
               'export_country','payment_terms','packing_list_number','packing_list_date',
               'declaration_type','declaration_status','declaration_date','declaration_date_hijri',
               'importer_name_ar','broker_name','local_value','payment_method',
               'appointment_booking_ref','appointment_ticket_no','appointment_operator','appointment_at',          -- APPT
               'appointment_zone_gate','appointment_barcode','appointment_movement_type','vehicle_plate',         -- APPT
               'driver_name','driver_phone',                                                                      -- APPT
               'appointment_gate_instructions','driver_license','vehicle_ref_id','vehicle_serial_id',            -- APPT
               'return_delivered_at','return_depot']                                                              -- APPT
$$;

-- one card section (entry / exit): NULL, or {location, bl_number, declaration_number, container_number, cargo_type, purpose}
-- of strings ≤ 300 / null
CREATE OR REPLACE FUNCTION app.extraction_appt_section_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR jsonb_typeof(p) = 'null' OR (
    jsonb_typeof(p) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e
                     WHERE NOT (e.key = ANY (ARRAY['location','bl_number','declaration_number','container_number','cargo_type','purpose']))
                        OR jsonb_typeof(e.value) NOT IN ('string','null') OR char_length(e.value #>> '{}') > 300))
$$;

-- the appointment part of an ai-doc-v3 card reading (extract.js postProcess): NULL, or an object of the known keys
CREATE OR REPLACE FUNCTION app.extraction_appt_detail_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object' AND octet_length(p::text) <= 20000
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e
                     WHERE NOT (e.key = ANY (ARRAY['booking_ref','operator_ticket_no','operator_name','appointment_at','appointment_local',
                                                   'truck_plate','driver_name','driver_phone','zone_gate','barcode','movement_type',
                                                   'container_no','document_title','entry','exit','structural',
                                                   'gate_instructions','driver_license','vehicle_ref_id','vehicle_serial_id']))
                        OR (e.key IN ('entry','exit') AND NOT app.extraction_appt_section_ok(e.value))
                        OR (e.key = 'structural' AND NOT (jsonb_typeof(e.value) = 'object'
                              AND NOT EXISTS (SELECT 1 FROM jsonb_each(e.value) s
                                               WHERE NOT (s.key = ANY (ARRAY['ok','has_time','has_booking','signals','reason']))
                                                  OR jsonb_typeof(s.value) NOT IN ('boolean','number','string','null')
                                                  OR char_length(s.value #>> '{}') > 60)))
                        OR (e.key = 'movement_type' AND jsonb_typeof(e.value) <> 'null'
                            AND NOT ((e.value #>> '{}') = ANY (ARRAY['full_exit','empty_entry'])))
                        OR (e.key NOT IN ('entry','exit','structural')
                            AND (jsonb_typeof(e.value) NOT IN ('string','null') OR char_length(e.value #>> '{}') > 300))))
$$;

-- the EIR part: NULL, or {container_no, delivered_at (with a time) | null, delivery_date, time_printed, depot, confidence 0..1,
-- movement}
CREATE OR REPLACE FUNCTION app.extraction_eir_detail_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e
                     WHERE NOT (e.key = ANY (ARRAY['container_no','delivered_at','delivery_date','time_printed','depot','confidence','movement']))
                        OR (e.key = 'time_printed' AND jsonb_typeof(e.value) NOT IN ('boolean','null'))
                        OR (e.key = 'confidence' AND NOT (jsonb_typeof(e.value) = 'null'
                              OR (jsonb_typeof(e.value) = 'number' AND (e.value #>> '{}')::numeric BETWEEN 0 AND 1)))
                        OR (e.key NOT IN ('time_printed','confidence')
                            AND (jsonb_typeof(e.value) NOT IN ('string','null') OR char_length(e.value #>> '{}') > 300))))
$$;

-- extraction_detail_ok (20261120000100 §1). APPT: + the detected types appointment_ticket / appointment_invoice /
-- empty_return_receipt and the keys appointment / empty_return; body otherwise identical.
CREATE OR REPLACE FUNCTION app.extraction_detail_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object' AND octet_length(p::text) <= 200000
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
                     WHERE NOT (k = ANY (ARRAY['prompt_version','detected_type','detected_documents','doc_type','containers','fields','warnings',
                                               'declaration','appointment','empty_return'])))                                -- APPT
    AND coalesce(p ->> 'prompt_version', '') ~ '^ai-doc-v[0-9]{1,2}$'
    AND (NOT p ? 'detected_type' OR (p ->> 'detected_type') = ANY (ARRAY['bill_of_lading','commercial_invoice','packing_list',
           'customs_declaration','supplier_invoice','other','appointment_ticket','appointment_invoice','empty_return_receipt']))  -- APPT
    AND (NOT p ? 'detected_documents' OR (jsonb_typeof(p -> 'detected_documents') = 'array' AND jsonb_array_length(p -> 'detected_documents') <= 6
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'detected_documents') t
                          WHERE jsonb_typeof(t) <> 'string' OR NOT ((t #>> '{}') = ANY (ARRAY['bill_of_lading','commercial_invoice','packing_list',
                                'customs_declaration','supplier_invoice','other','appointment_ticket','appointment_invoice',       -- APPT
                                'empty_return_receipt'])))))                                                                       -- APPT
    AND (NOT p ? 'doc_type' OR char_length(p ->> 'doc_type') <= 40)
    AND (NOT p ? 'containers' OR (jsonb_typeof(p -> 'containers') = 'array' AND jsonb_array_length(p -> 'containers') <= 300
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'containers') c
                          WHERE jsonb_typeof(c) <> 'object'
                             OR jsonb_typeof(c -> 'container_number') IS DISTINCT FROM 'string'
                             OR EXISTS (SELECT 1 FROM jsonb_each(c) e
                                         WHERE NOT (e.key = ANY (ARRAY['container_number','seal_number','size_type','packages_count',
                                                                       'net_weight','gross_weight']))
                                            OR jsonb_typeof(e.value) NOT IN ('string','number','null')
                                            OR char_length(e.value #>> '{}') > 40))))
    AND (NOT p ? 'fields' OR (jsonb_typeof(p -> 'fields') = 'array' AND jsonb_array_length(p -> 'fields') <= 100))
    AND (NOT p ? 'warnings' OR (jsonb_typeof(p -> 'warnings') = 'array' AND jsonb_array_length(p -> 'warnings') <= 60))
    AND (NOT p ? 'declaration' OR app.extraction_decl_detail_ok(p -> 'declaration'))
    AND (NOT p ? 'appointment' OR app.extraction_appt_detail_ok(p -> 'appointment'))                                -- APPT
    AND (NOT p ? 'empty_return' OR app.extraction_eir_detail_ok(p -> 'empty_return')))                              -- APPT
$$;

-- ---------------------------------------------------------------------
-- 2. columns: port_appointments (the card), transport_trips (the transport party)
-- ---------------------------------------------------------------------
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS booking_ref text;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS operator_ticket_no text;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS operator_name text;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS zone_gate text;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS barcode text;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS movement_type text;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS source_document_id uuid;
ALTER TABLE public.port_appointments ADD COLUMN IF NOT EXISTS extraction_id uuid;
ALTER TABLE public.port_appointments DROP CONSTRAINT IF EXISTS port_appointments_card_chk;
ALTER TABLE public.port_appointments ADD CONSTRAINT port_appointments_card_chk CHECK (
  char_length(booking_ref) <= 40 AND char_length(operator_ticket_no) <= 60 AND char_length(operator_name) <= 160 AND char_length(zone_gate) <= 120
  AND char_length(barcode) <= 200);
ALTER TABLE public.port_appointments DROP CONSTRAINT IF EXISTS port_appointments_movement_type_chk;
ALTER TABLE public.port_appointments ADD CONSTRAINT port_appointments_movement_type_chk
  CHECK (movement_type IS NULL OR movement_type IN ('full_exit','empty_entry'));
ALTER TABLE public.port_appointments DROP CONSTRAINT IF EXISTS port_appointments_source_document_fk;
ALTER TABLE public.port_appointments ADD CONSTRAINT port_appointments_source_document_fk
  FOREIGN KEY (source_document_id, org_id) REFERENCES public.documents(id, org_id);
ALTER TABLE public.port_appointments DROP CONSTRAINT IF EXISTS port_appointments_extraction_fk;
ALTER TABLE public.port_appointments ADD CONSTRAINT port_appointments_extraction_fk
  FOREIGN KEY (extraction_id, org_id) REFERENCES public.document_extractions(id, org_id);
COMMENT ON COLUMN public.port_appointments.booking_ref IS 'legacy step 5 (20261121000100): the TAS booking reference of the approved card (also kept in appointment_no). With operator_ticket_no, operator_name (the terminal operator as read / reviewed: legacy appointmentOperator), zone_gate, barcode, movement_type, source_document_id (the card file) and extraction_id (the reading); written by approve_appointment_draft only.';

ALTER TABLE public.transport_trips ADD COLUMN IF NOT EXISTS party_type text;
ALTER TABLE public.transport_trips ADD COLUMN IF NOT EXISTS party_name text;
ALTER TABLE public.transport_trips ADD COLUMN IF NOT EXISTS transport_order_no text;
ALTER TABLE public.transport_trips DROP CONSTRAINT IF EXISTS transport_trips_party_chk;
ALTER TABLE public.transport_trips ADD CONSTRAINT transport_trips_party_chk CHECK (
  (party_type IS NULL OR party_type IN ('supplier','company','direct'))
  AND char_length(party_name) <= 160 AND char_length(transport_order_no) <= 60);
COMMENT ON COLUMN public.transport_trips.party_type IS 'legacy step 5 (20261121000100, R12TransportPurchases saveMovementTransportPartyR12): who carries the trip — supplier / company / direct (the driver); party_name, transport_order_no (per-trip order). The Daftra supplier link and purchase draft are step 7.';

-- movement_json (20261118000100 §3, re-created): APPT + the card fields of the appointment (booking ref, operator ticket,
-- operator, zone / gate, barcode, movement type, card file) and the trip party (type, name, per-trip order), so
-- list_movements / save_movement show what an approved card wrote. Body otherwise identical.
CREATE OR REPLACE FUNCTION app.movement_json(a public.port_appointments, r public.transport_trips, p_fin boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'appointment_id', a.id, 'trip_id', r.id, 'transaction_id', coalesce(a.transaction_id, r.transaction_id),
    'container_id', coalesce(a.container_id, r.container_id), 'container_no', c.container_no,
    'appointment_at', a.appointment_at, 'appointment_no', a.appointment_no, 'appointment_status', a.status,
    'terminal_party_id', a.terminal_party_id, 'window_minutes', a.window_minutes,
    'driver_id', coalesce(r.driver_id, a.driver_id), 'driver_name', d.full_name, 'driver_phone', d.phone,
    'truck_id', coalesce(r.truck_id, a.truck_id), 'truck_plate', k.plate_no, 'carrier_id', r.carrier_id,
    'origin', r.origin, 'destination', r.destination, 'trip_status', r.status, 'unloaded_at', r.unloaded_at, 'notes', r.notes,
    'movement_status', app.movement_status(a, r),
    'cost_amount', CASE WHEN p_fin THEN r.cost_amount END, 'sell_amount', CASE WHEN p_fin THEN r.sell_amount END,
    'return_deadline', c.return_deadline, 'return_location', c.return_location, 'return_yard_party_id', c.return_yard_party_id,
    'return_status', c.return_status,
    'created_at', least(a.created_at, r.created_at), 'updated_at', greatest(a.updated_at, r.updated_at))
    || jsonb_build_object(                                                                                         -- APPT
    'booking_ref', a.booking_ref, 'operator_ticket_no', a.operator_ticket_no, 'operator_name', a.operator_name,      -- APPT
    'zone_gate', a.zone_gate, 'barcode', a.barcode, 'movement_type', a.movement_type,                                -- APPT
    'source_document_id', a.source_document_id, 'party_type', r.party_type, 'party_name', r.party_name,             -- APPT
    'transport_order_no', r.transport_order_no)                                                                    -- APPT
    FROM (SELECT 1) one
    LEFT JOIN public.containers c ON c.id = coalesce(a.container_id, r.container_id)
    LEFT JOIN public.drivers d ON d.id = coalesce(r.driver_id, a.driver_id)
    LEFT JOIN public.trucks k ON k.id = coalesce(r.truck_id, a.truck_id)
$$;

-- ---------------------------------------------------------------------
-- 3. tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.appointment_drafts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL,
  transaction_id            uuid NOT NULL,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','approved','cancelled','moved')),
  version                   int NOT NULL DEFAULT 1 CHECK (version >= 1),
  note                      text CHECK (char_length(note) <= 1000),
  moved_from_transaction_id uuid,
  moved_to_batch_id         uuid,
  close_reason              text CHECK (char_length(close_reason) <= 500),
  created_by                uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by                uuid,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  closed_by                 uuid,
  closed_at                 timestamptz,
  CONSTRAINT appointment_drafts_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT appointment_drafts_from_fk FOREIGN KEY (moved_from_transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT appointment_drafts_closed_chk CHECK ((status IN ('approved','cancelled','moved')) = (closed_at IS NOT NULL)),
  CONSTRAINT appointment_drafts_moved_chk CHECK ((status = 'moved') = (moved_to_batch_id IS NOT NULL)),
  UNIQUE (id, org_id)
);
ALTER TABLE public.appointment_drafts DROP CONSTRAINT IF EXISTS appointment_drafts_moved_to_fk;
ALTER TABLE public.appointment_drafts ADD CONSTRAINT appointment_drafts_moved_to_fk
  FOREIGN KEY (moved_to_batch_id, org_id) REFERENCES public.appointment_drafts(id, org_id);
COMMENT ON TABLE public.appointment_drafts IS 'legacy step 5 «مسودات المواعيد» (R1213_APPOINTMENT_DRAFT): one batch of up to 20 appointment cards (25 MB) read for a transaction. The reading is a DRAFT: restored on reopen without a new read, autosaved while reviewed, cancelled (cards released), moved to another transaction by its number, approved card by card (save_movement). Approved / partly approved batches cannot be cancelled or moved. Written only by the RPCs; no DELETE.';
-- one open batch per transaction (legacy getPendingAppointmentDraftR1213)
CREATE UNIQUE INDEX IF NOT EXISTS appointment_drafts_open_uidx ON public.appointment_drafts (transaction_id) WHERE status IN ('pending','partial');
CREATE INDEX IF NOT EXISTS appointment_drafts_org_idx ON public.appointment_drafts (org_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.appointment_draft_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  batch_id        uuid NOT NULL,
  seq             int NOT NULL CHECK (seq BETWEEN 1 AND 1000),
  file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_size       bigint NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
  media_type      text CHECK (media_type IN ('image/jpeg','image/png','image/webp','image/gif','application/pdf')),
  source_sha256   text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  extraction_id   uuid,
  document_id     uuid,
  origin_transaction_id uuid NOT NULL,
  reading         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reading) = 'object' AND octet_length(reading::text) <= 60000),
  review          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(review) = 'object' AND octet_length(review::text) <= 20000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','skipped','failed','discarded','cancelled')),
  result          jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 20000)),
  appointment_id  uuid,
  trip_id         uuid,
  link_voided_at  timestamptz,
  link_void_reason text CHECK (char_length(link_void_reason) <= 120),
  approved_by     uuid,
  approved_at     timestamptz,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_draft_cards_batch_fk FOREIGN KEY (batch_id, org_id) REFERENCES public.appointment_drafts(id, org_id),
  CONSTRAINT appointment_draft_cards_ext_fk FOREIGN KEY (extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  CONSTRAINT appointment_draft_cards_doc_fk FOREIGN KEY (document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT appointment_draft_cards_origin_fk FOREIGN KEY (origin_transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT appointment_draft_cards_appt_fk FOREIGN KEY (appointment_id, org_id) REFERENCES public.port_appointments(id, org_id),
  CONSTRAINT appointment_draft_cards_trip_fk FOREIGN KEY (trip_id, org_id) REFERENCES public.transport_trips(id, org_id),
  CONSTRAINT appointment_draft_cards_approved_chk CHECK ((status = 'approved') = (appointment_id IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT appointment_draft_cards_link_chk CHECK ((link_voided_at IS NULL) = (link_void_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.appointment_draft_cards IS 'legacy step 5: one appointment card of a draft batch — the file hash (the fingerprint checked across the org: app.appointment_fingerprint_state), the reading (ai-doc-v3 appointment_ticket, a draft), the staff review, the status and the per-card approval result (saved / already existed / skipped / failed), the movement link (voided when the appointment is cancelled: the card can be read again). Written only by the RPCs; no DELETE.';
-- one LIVE card per file in a batch (pending / failed / discarded); a final card (approved — its appointment may be cancelled
-- later, which releases the file —, skipped, cancelled) does not block a new read of the same file in the same batch
DROP INDEX IF EXISTS public.appointment_draft_cards_sha_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS appointment_draft_cards_sha_uidx ON public.appointment_draft_cards (batch_id, source_sha256)
  WHERE status IN ('pending','failed','discarded');
CREATE INDEX IF NOT EXISTS appointment_draft_cards_fp_idx ON public.appointment_draft_cards (org_id, source_sha256);
CREATE INDEX IF NOT EXISTS appointment_draft_cards_appt_idx ON public.appointment_draft_cards (appointment_id) WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.empty_return_proofs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  transaction_id  uuid NOT NULL,
  container_id    uuid,
  container_no    text CHECK (container_no ~ '^[A-Z]{4}[0-9]{7}$'),
  document_id     uuid NOT NULL,
  extraction_id   uuid,
  source          text NOT NULL CHECK (source IN ('ai','manual')),
  delivered_at    timestamptz,
  depot           text CHECK (char_length(depot) <= 160),
  confidence      numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  status          text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','unreadable','voided')),
  match_notes     text CHECK (char_length(match_notes) <= 2000),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  verified_by     uuid,
  verified_at     timestamptz,
  voided_by       uuid,
  voided_at       timestamptz,
  void_reason     text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT empty_return_proofs_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT empty_return_proofs_container_fk FOREIGN KEY (container_id, transaction_id) REFERENCES public.containers(id, transaction_id),
  CONSTRAINT empty_return_proofs_doc_fk FOREIGN KEY (document_id, org_id) REFERENCES public.documents(id, org_id),
  CONSTRAINT empty_return_proofs_ext_fk FOREIGN KEY (extraction_id, org_id) REFERENCES public.document_extractions(id, org_id),
  CONSTRAINT empty_return_proofs_verified_chk CHECK ((verified_at IS NOT NULL) = (verified_by IS NOT NULL)
    AND (status <> 'approved' OR (verified_at IS NOT NULL AND container_id IS NOT NULL AND delivered_at IS NOT NULL AND depot IS NOT NULL))),
  CONSTRAINT empty_return_proofs_void_chk CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.empty_return_proofs IS 'legacy step 5 «إثباتات إعادة الفارغ» (EMPTY_RETURN_PROOF_R12110): one uploaded proof that an empty container was returned (EIR / gate-in, PDF or image ≤ 8 MB), read by Claude (source ai, a DRAFT) or entered by hand. pending_review / unreadable until a staff member verifies it (verify_empty_return_proof writes the container return: returned_verified + the evidence document) — never applied automatically. A void is soft and reverts the container return only when no other approved proof remains. Written only by the RPCs; no DELETE.';
CREATE INDEX IF NOT EXISTS empty_return_proofs_tx_idx ON public.empty_return_proofs (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS empty_return_proofs_container_idx ON public.empty_return_proofs (container_id) WHERE status = 'approved';

-- guards: no DELETE; the identity columns never change; a closed draft / a voided proof / a final card is frozen
CREATE OR REPLACE FUNCTION app.tg_legacy_appt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'appointment_drafts' THEN
    IF OLD.status IN ('approved','cancelled','moved') THEN PERFORM app.fail('MRS_IMMUTABLE', 'status'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','created_by','created_at']);
  ELSIF TG_TABLE_NAME = 'appointment_draft_cards' THEN
    -- a final card only changes its movement link (voided / re-pointed by a reschedule)
    IF OLD.status IN ('approved','skipped','cancelled') AND OLD.status = NEW.status THEN
      PERFORM app.guard_immutable(to_jsonb(OLD) - ARRAY['appointment_id','link_voided_at','link_void_reason','updated_at','batch_id','seq'],
                                  to_jsonb(NEW) - ARRAY['appointment_id','link_voided_at','link_void_reason','updated_at','batch_id','seq'],
                                  ARRAY(SELECT jsonb_object_keys(to_jsonb(OLD) - ARRAY['appointment_id','link_voided_at','link_void_reason','updated_at','batch_id','seq'])));
    END IF;
    IF OLD.status IN ('approved','skipped','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM app.fail('MRS_IMMUTABLE', 'status');
    END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','source_sha256','file_name','file_size','origin_transaction_id',
                                                                    'created_by','created_at']);
  ELSIF TG_TABLE_NAME = 'empty_return_proofs' THEN
    IF OLD.status = 'voided' THEN PERFORM app.fail('MRS_IMMUTABLE', 'voided_at'); END IF;
    PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['id','org_id','transaction_id','document_id','source','created_by','created_at']);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard ON public.appointment_drafts;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.appointment_drafts FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_appt_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.appointment_draft_cards;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.appointment_draft_cards FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_appt_guard();
DROP TRIGGER IF EXISTS trg_guard ON public.empty_return_proofs;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.empty_return_proofs FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_appt_guard();
DROP TRIGGER IF EXISTS trg_no_delete ON public.appointment_drafts;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.appointment_drafts FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.appointment_draft_cards;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.appointment_draft_cards FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
DROP TRIGGER IF EXISTS trg_no_delete ON public.empty_return_proofs;
CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.empty_return_proofs FOR EACH ROW EXECUTE FUNCTION app.tg_legacy_docs_no_delete();
-- the trail without the document content (reading / review / result values, notes, depot)
DROP TRIGGER IF EXISTS trg_audit ON public.appointment_drafts;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.appointment_drafts FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('note', 'close_reason');
DROP TRIGGER IF EXISTS trg_audit ON public.appointment_draft_cards;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.appointment_draft_cards FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('reading', 'review', 'result', 'file_name');
DROP TRIGGER IF EXISTS trg_audit ON public.empty_return_proofs;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.empty_return_proofs FOR EACH ROW
  EXECUTE FUNCTION app.tg_legacy_docs_audit('depot', 'match_notes', 'void_reason');

-- ---------------------------------------------------------------------
-- 4. helpers
-- ---------------------------------------------------------------------
-- the billing gate policy (owner decision 2026-11-10): billing needs a verified empty return for every container. A
-- read-only flag in this step — not an org setting a tenant can switch off; set_transaction_status keeps the hard block.
CREATE OR REPLACE FUNCTION app.empty_return_blocks_billing(p_org uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT true
$$;

-- a date WITH a time from a payload (legacy normalizeEmptyReturnDateTimeR12110_: a date without a time is refused);
-- no offset = Saudi local time (Asia/Riyadh). MRS_DATETIME_REQUIRED <k> for a date alone, MRS_INVALID <k> otherwise.
CREATE OR REPLACE FUNCTION app.appt_ts(p jsonb, k text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE s text := nullif(btrim(app.to_western(coalesce(p ->> k, ''))), '');
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'string' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  s := replace(s, '/', '-');
  IF s ~ '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$' OR s ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' THEN PERFORM app.fail('MRS_DATETIME_REQUIRED', k); END IF;
  IF s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{1,2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$' THEN
    PERFORM app.fail('MRS_INVALID', k);
  END IF;
  BEGIN
    IF s ~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN RETURN s::timestamptz; END IF;
    RETURN (s::timestamp) AT TIME ZONE 'Asia/Riyadh';
  EXCEPTION WHEN others THEN
    PERFORM app.fail('MRS_INVALID', k);
  END;
  RETURN NULL;
END $$;

-- the staff review of a card: an object of the known keys, each a string / number / null of a bounded size
CREATE OR REPLACE FUNCTION app.appt_review_check(p jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE e record;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'review'); END IF;
  FOR e IN SELECT * FROM jsonb_each(p) LOOP
    IF NOT (e.key = ANY (ARRAY['container_id','container_no','appointment_at','booking_ref','operator_ticket_no','operator_name',
                               'terminal_party_id','zone_gate','barcode','movement_type','driver_name','driver_phone','truck_plate',
                               'party_type','carrier_id','party_name','transport_order_no','destination','origin','notes',
                               'return_deadline','return_location','cost_amount','sell_amount','gate_instructions','driver_license'])) THEN
      PERFORM app.fail('MRS_INVALID', 'review.' || left(e.key, 40));
    END IF;
    IF jsonb_typeof(e.value) NOT IN ('string','number','null') OR char_length(e.value #>> '{}') > 1000 THEN
      PERFORM app.fail('MRS_INVALID', 'review.' || e.key);
    END IF;
    IF e.key IN ('container_id','terminal_party_id','carrier_id') AND jsonb_typeof(e.value) = 'string'
       AND (e.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      PERFORM app.fail('MRS_INVALID', 'review.' || e.key);
    END IF;
    IF e.key = 'movement_type' AND jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') NOT IN ('full_exit','empty_entry') THEN
      PERFORM app.fail('MRS_INVALID', 'review.movement_type');
    END IF;
    IF e.key = 'party_type' AND jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') NOT IN ('supplier','company','direct') THEN
      PERFORM app.fail('MRS_INVALID', 'review.party_type');
    END IF;
  END LOOP;
END $$;

-- the value of a card field: the staff review when it has the key (null = cleared), else the reading
CREATE OR REPLACE FUNCTION app.appt_card_val(c public.appointment_draft_cards, k text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN c.review ? k THEN nullif(btrim(c.review ->> k), '')
              ELSE nullif(btrim(c.reading -> 'appointment' ->> k), '') END
$$;

-- legacy appointmentDocumentAllowsRereadR12110HF9_ / releaseApprovedAppointmentIfOrphanedR12110HF9_: the state of a card
-- file (its SHA-256) across the org → {state free | pending | approved | released, card_id, batch_id, transaction_id,
-- appointment_id}. approved = a saved movement still holds it (link live, transaction live); pending = an open batch holds it
-- for review; released = only history (cancelled / discarded card, cancelled appointment or transaction): it may be read again.
CREATE OR REPLACE FUNCTION app.appointment_fingerprint_state(p_org uuid, p_sha text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH c AS (
    SELECT c.id, c.batch_id, c.status, c.appointment_id, c.link_voided_at, c.created_at, d.transaction_id, d.status bstatus,
           (t.cancelled_at IS NOT NULL) tx_cancelled
      FROM public.appointment_draft_cards c
      JOIN public.appointment_drafts d ON d.id = c.batch_id
      JOIN public.transactions t ON t.id = d.transaction_id
     WHERE c.org_id = p_org AND c.source_sha256 = p_sha),
  s AS (
    SELECT c.*, CASE
      WHEN c.status = 'approved' AND c.appointment_id IS NOT NULL AND c.link_voided_at IS NULL AND NOT c.tx_cancelled THEN 'approved'
      WHEN c.status IN ('pending','failed') AND c.bstatus IN ('pending','partial') AND NOT c.tx_cancelled THEN 'pending'
      ELSE 'released' END st
      FROM c)
  SELECT coalesce(
    (SELECT jsonb_build_object('state', s.st, 'card_id', s.id, 'batch_id', s.batch_id, 'transaction_id', s.transaction_id,
                               'appointment_id', CASE WHEN s.st = 'approved' THEN s.appointment_id END)
       FROM s ORDER BY (s.st = 'approved') DESC, (s.st = 'pending') DESC, s.created_at DESC, s.id LIMIT 1),
    jsonb_build_object('state', 'free', 'card_id', NULL, 'batch_id', NULL, 'transaction_id', NULL, 'appointment_id', NULL))
$$;

-- one card as JSON (cost / sell of the review only for trip-finance roles; amounts_hidden tells the other roles that a
-- trip-finance user entered amounts: kept on their autosaves, and the card needs a trip-finance approver)
CREATE OR REPLACE FUNCTION app.appt_card_json(c public.appointment_draft_cards, p_fin boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', c.id, 'seq', c.seq, 'file_name', c.file_name, 'file_size', c.file_size, 'media_type', c.media_type,
    'source_sha256', c.source_sha256, 'extraction_id', c.extraction_id, 'document_id', c.document_id,
    'origin_transaction_id', c.origin_transaction_id, 'reading', c.reading,
    'review', CASE WHEN p_fin THEN c.review ELSE c.review - ARRAY['cost_amount','sell_amount'] END,
    'amounts_hidden', NOT p_fin AND (c.review ? 'cost_amount' OR c.review ? 'sell_amount'),
    'status', c.status, 'result', c.result, 'appointment_id', c.appointment_id, 'trip_id', c.trip_id,
    'link_voided_at', c.link_voided_at, 'link_void_reason', c.link_void_reason, 'approved_by', c.approved_by,
    'approved_at', c.approved_at, 'created_at', c.created_at, 'updated_at', c.updated_at)
$$;

-- a draft batch as JSON: the batch, its cards (in order), the counts, the transaction's containers (for the review)
CREATE OR REPLACE FUNCTION app.appt_draft_json(d public.appointment_drafts) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_fin boolean;
BEGIN
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = d.transaction_id;
  v_fin := app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.trip_finance_roles());
  RETURN jsonb_build_object(
    'id', d.id, 'org_id', d.org_id, 'transaction_id', d.transaction_id, 'ref', v_tx.ref, 'cargo_unit_type', v_tx.cargo_unit_type,
    'status', d.status, 'version', d.version, 'note', d.note, 'moved_from_transaction_id', d.moved_from_transaction_id,
    'moved_to_batch_id', d.moved_to_batch_id, 'close_reason', d.close_reason, 'created_by', d.created_by, 'created_at', d.created_at,
    'updated_by', d.updated_by, 'updated_at', d.updated_at, 'closed_by', d.closed_by, 'closed_at', d.closed_at,
    'can_edit', d.status IN ('pending','partial') AND app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.transport_writer_roles()),
    'finance', v_fin,
    'limits', jsonb_build_object('cards', 20, 'bytes', 26214400),
    'total_bytes', coalesce((SELECT sum(c.file_size) FROM public.appointment_draft_cards c
                              WHERE c.batch_id = d.id AND c.status NOT IN ('discarded','cancelled')), 0),
    'counts', (SELECT jsonb_build_object(
                 'total', count(*), 'pending', count(*) FILTER (WHERE c.status = 'pending'),
                 'approved', count(*) FILTER (WHERE c.status = 'approved'), 'skipped', count(*) FILTER (WHERE c.status = 'skipped'),
                 'failed', count(*) FILTER (WHERE c.status = 'failed'), 'discarded', count(*) FILTER (WHERE c.status = 'discarded'),
                 'cancelled', count(*) FILTER (WHERE c.status = 'cancelled'))
                 FROM public.appointment_draft_cards c WHERE c.batch_id = d.id),
    'cards', coalesce((SELECT jsonb_agg(app.appt_card_json(c, v_fin) ORDER BY c.seq, c.created_at)
                         FROM public.appointment_draft_cards c WHERE c.batch_id = d.id), '[]'::jsonb),
    'containers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'container_no', x.container_no, 'return_status', x.return_status)
                                             ORDER BY x.container_no)
                              FROM public.containers x WHERE x.transaction_id = d.transaction_id), '[]'::jsonb),
    -- the transaction's B/L and declaration numbers (legacy compareAppointmentWithTransaction_: the review flags a card
    -- whose B/L / declaration is not the transaction's)
    'bl_numbers', coalesce((SELECT jsonb_agg(DISTINCT z.n ORDER BY z.n) FROM (
                     SELECT b.bl_number n FROM public.transaction_bls l JOIN public.bills_of_lading b ON b.id = l.bl_id WHERE l.transaction_id = d.transaction_id
                     UNION SELECT nullif(btrim(v_tx.bl_number), '')) z WHERE z.n IS NOT NULL), '[]'::jsonb),
    'declaration_numbers', coalesce((SELECT jsonb_agg(DISTINCT x.declaration_no ORDER BY x.declaration_no) FROM public.customs_declarations x
                                      WHERE x.transaction_id = d.transaction_id AND x.status NOT IN ('cancelled','replaced')), '[]'::jsonb));
END $$;

-- the batch locked for a write by a transport writer of its transaction's branch (the transaction locked first)
CREATE OR REPLACE FUNCTION app.appt_draft_lock(p_batch uuid) RETURNS public.appointment_drafts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.appointment_drafts;
BEGIN
  SELECT * INTO d FROM public.appointment_drafts x WHERE x.id = p_batch;
  IF d.id IS NULL OR NOT app.has_tx_role(d.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'appointment_draft'); END IF;
  PERFORM app.g3_lock_tx(d.transaction_id, app.transport_writer_roles());
  SELECT * INTO d FROM public.appointment_drafts x WHERE x.id = p_batch FOR UPDATE;
  RETURN d;
END $$;

-- one card → its movement (legacy saveReviewedAppointments, per card): only a full-exit card becomes a movement (a card
-- read / reviewed as an empty entry is 'skipped'; a card whose movement type is unknown FAILS with MRS_REQUIRED
-- movement_type and stays editable, as the legacy throw did); the container must be one of the transaction's; a transport party is required (direct
-- defaults to the driver); save_movement (step 2: the duplicate-appointment guard with idempotent = true → already_existed,
-- the driver / truck auto-upsert, the lifecycle) writes the appointment + trip; the card's fields are then put on the
-- appointment and the party on the trip; the reading is marked reviewed. Raises on any refusal (the caller records it).
-- → {outcome saved | already_existed | skipped, appointment_id, trip_id, movement}
CREATE OR REPLACE FUNCTION app.appt_card_approve(p_tx public.transactions, c public.appointment_draft_cards) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_mt text := app.appt_card_val(c, 'movement_type'); v_ctr uuid; v_no text; v_p jsonb; v_r jsonb; v_aid uuid; v_tid uuid;
  v_pt text := app.appt_card_val(c, 'party_type'); v_pn text := app.appt_card_val(c, 'party_name');
  v_carrier uuid; v_driver text := app.appt_card_val(c, 'driver_name'); v_notes text; v_doc uuid; v_k text;
  v_at timestamptz; v_ext uuid;
BEGIN
  IF v_mt IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'movement_type'); END IF;
  IF v_mt = 'empty_entry' THEN
    RETURN jsonb_build_object('outcome', 'skipped', 'appointment_id', NULL, 'trip_id', NULL, 'movement', NULL,
                              'movement_type', v_mt);
  END IF;
  -- the container: one of this transaction's (by id, or by number as read / reviewed); none on Ro-Ro
  IF p_tx.cargo_unit_type <> 'roro' THEN
    IF c.review ? 'container_id' AND nullif(c.review ->> 'container_id', '') IS NOT NULL THEN
      SELECT x.id INTO v_ctr FROM public.containers x WHERE x.id = (c.review ->> 'container_id')::uuid AND x.transaction_id = p_tx.id;
    ELSE
      v_no := upper(regexp_replace(app.to_western(coalesce(app.appt_card_val(c, 'container_no'), '')), '[^A-Za-z0-9]', '', 'g'));
      SELECT x.id INTO v_ctr FROM public.containers x WHERE x.transaction_id = p_tx.id AND x.container_no = v_no;
    END IF;
    IF v_ctr IS NULL THEN PERFORM app.fail('MRS_APPT_CONTAINER_NOT_IN_TX', coalesce(nullif(v_no, ''), 'container')); END IF;
  END IF;
  -- the transport party (R12 saveMovementTransportPartyR12: type and name required; direct = the driver)
  IF v_pt IS NULL THEN PERFORM app.fail('MRS_APPT_PARTY_REQUIRED', 'party_type'); END IF;
  IF c.review ? 'carrier_id' AND nullif(c.review ->> 'carrier_id', '') IS NOT NULL THEN
    v_carrier := (c.review ->> 'carrier_id')::uuid;
    PERFORM app.g3_check_party(p_tx.org_id, v_carrier, ARRAY['carrier'], 'carrier_id');
    IF v_pn IS NULL THEN SELECT left(pa.name_ar, 160) INTO v_pn FROM public.parties pa WHERE pa.id = v_carrier; END IF;
  END IF;
  IF v_pt = 'direct' AND v_pn IS NULL THEN v_pn := left(v_driver, 160); END IF;
  IF v_pn IS NULL THEN PERFORM app.fail('MRS_APPT_PARTY_REQUIRED', 'party_name'); END IF;
  v_at := app.appt_ts(jsonb_build_object('appointment_at', app.appt_card_val(c, 'appointment_at')), 'appointment_at');
  IF v_at IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'appointment_at'); END IF;
  -- legacy mergeNotes_: the reviewer's notes, gate instructions, zone / gate, barcode, driver licence, vehicle ref / serial
  SELECT string_agg(x, ' | ' ORDER BY o) INTO v_notes FROM (
    SELECT DISTINCT ON (x) x, o FROM unnest(ARRAY[app.appt_card_val(c, 'notes'),
      CASE WHEN app.appt_card_val(c, 'gate_instructions') IS NOT NULL THEN 'تعليمات البوابة: ' || app.appt_card_val(c, 'gate_instructions') END,
      CASE WHEN app.appt_card_val(c, 'zone_gate') IS NOT NULL THEN 'المنطقة/البوابة: ' || app.appt_card_val(c, 'zone_gate') END,
      CASE WHEN app.appt_card_val(c, 'barcode') IS NOT NULL THEN 'باركود البطاقة: ' || app.appt_card_val(c, 'barcode') END,
      CASE WHEN app.appt_card_val(c, 'driver_license') IS NOT NULL THEN 'رخصة السائق: ' || app.appt_card_val(c, 'driver_license') END,
      CASE WHEN app.appt_card_val(c, 'vehicle_ref_id') IS NOT NULL THEN 'مرجع المركبة: ' || app.appt_card_val(c, 'vehicle_ref_id') END,
      CASE WHEN app.appt_card_val(c, 'vehicle_serial_id') IS NOT NULL THEN 'الرقم التسلسلي للمركبة: ' || app.appt_card_val(c, 'vehicle_serial_id') END])
      WITH ORDINALITY AS u(x, o) WHERE x IS NOT NULL ORDER BY x, o) z;
  v_p := jsonb_strip_nulls(jsonb_build_object(
    'transaction_id', p_tx.id, 'container_id', v_ctr, 'appointment_at', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'appointment_no', left(app.appt_card_val(c, 'booking_ref'), 60),
    'terminal_party_id', app.appt_card_val(c, 'terminal_party_id'),
    'driver_name', v_driver, 'driver_phone', app.appt_card_val(c, 'driver_phone'), 'truck_plate', app.appt_card_val(c, 'truck_plate'),
    'carrier_id', v_carrier, 'origin', app.appt_card_val(c, 'origin'), 'destination', app.appt_card_val(c, 'destination'),
    'notes', left(v_notes, 1000), 'return_deadline', app.appt_card_val(c, 'return_deadline'),
    'return_location', app.appt_card_val(c, 'return_location'), 'idempotent', true));
  FOREACH v_k IN ARRAY ARRAY['cost_amount','sell_amount'] LOOP
    IF c.review ? v_k AND jsonb_typeof(c.review -> v_k) <> 'null' THEN v_p := v_p || jsonb_build_object(v_k, c.review -> v_k); END IF;
  END LOOP;
  v_r := public.save_movement(v_p, NULL);
  v_aid := (v_r -> 'movement' ->> 'appointment_id')::uuid;
  v_tid := (v_r -> 'movement' ->> 'trip_id')::uuid;
  IF v_aid IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'appointment_at'); END IF;
  -- the card file: a live document of this transaction or of the transaction the card was read on (a moved card keeps its
  -- file there: the storage path is bound to the transaction); the reading: one of those (or not bound to any) — never
  -- another transaction's / branch's reading
  SELECT dd.id INTO v_doc FROM public.documents dd
   WHERE dd.id = c.document_id AND dd.transaction_id IN (p_tx.id, c.origin_transaction_id) AND dd.voided_at IS NULL;
  SELECT x.id INTO v_ext FROM public.document_extractions x
   WHERE x.id = c.extraction_id AND x.org_id = p_tx.org_id AND (x.transaction_id IS NULL OR x.transaction_id IN (p_tx.id, c.origin_transaction_id));
  UPDATE public.port_appointments a SET
    booking_ref        = coalesce(a.booking_ref, left(app.appt_card_val(c, 'booking_ref'), 40)),
    operator_ticket_no = coalesce(a.operator_ticket_no, left(app.appt_card_val(c, 'operator_ticket_no'), 60)),
    operator_name      = coalesce(a.operator_name, left(app.appt_card_val(c, 'operator_name'), 160)),
    zone_gate          = coalesce(a.zone_gate, left(app.appt_card_val(c, 'zone_gate'), 120)),
    barcode            = coalesce(a.barcode, left(app.appt_card_val(c, 'barcode'), 200)),
    movement_type      = coalesce(a.movement_type, 'full_exit'),
    source_document_id = coalesce(a.source_document_id, v_doc),
    extraction_id      = coalesce(a.extraction_id, v_ext)
   WHERE a.id = v_aid;
  IF v_tid IS NOT NULL THEN
    UPDATE public.transport_trips r SET party_type = coalesce(r.party_type, v_pt), party_name = coalesce(r.party_name, v_pn),
           transport_order_no = coalesce(r.transport_order_no, left(app.appt_card_val(c, 'transport_order_no'), 60))
     WHERE r.id = v_tid;
  END IF;
  IF v_ext IS NOT NULL THEN
    UPDATE public.document_extractions x SET review_status = 'reviewed'
     WHERE x.id = v_ext AND x.review_status = 'unreviewed' AND x.voided_at IS NULL;
  END IF;
  RETURN jsonb_build_object('outcome', CASE WHEN coalesce((v_r ->> 'already_exists')::boolean, false) THEN 'already_existed' ELSE 'saved' END,
    'appointment_id', v_aid, 'trip_id', v_tid, 'movement', v_r -> 'movement',
    'pending_containers', v_r -> 'pending_containers', 'lifecycle_status', v_r -> 'lifecycle_status');
END $$;

-- a proof as JSON
CREATE OR REPLACE FUNCTION app.erp_json(p public.empty_return_proofs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', p.id, 'org_id', p.org_id, 'transaction_id', p.transaction_id, 'container_id', p.container_id,
    'container_no', p.container_no, 'document_id', p.document_id, 'extraction_id', p.extraction_id, 'source', p.source,
    'delivered_at', p.delivered_at, 'depot', p.depot, 'confidence', p.confidence, 'status', p.status, 'match_notes', p.match_notes,
    'created_by', p.created_by, 'created_at', p.created_at, 'updated_at', p.updated_at, 'verified_by', p.verified_by,
    'verified_at', p.verified_at, 'voided_by', p.voided_by, 'voided_at', p.voided_at, 'void_reason', p.void_reason)
$$;

-- the readiness of a transaction (legacy getTransactionEmptyReturnReadiness_), without the access check
CREATE OR REPLACE FUNCTION app.tx_readiness_of(v_tx public.transactions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH pc AS (
    SELECT c.id, c.container_no, c.return_status, c.return_deadline,
           (c.return_deadline IS NOT NULL AND c.return_deadline < (now() AT TIME ZONE 'Asia/Riyadh')::date) overdue,
           (SELECT count(*) FROM public.empty_return_proofs p WHERE p.container_id = c.id AND p.status = 'pending_review')::int proofs_pending
      FROM public.containers c
     WHERE c.transaction_id = v_tx.id AND c.return_status NOT IN ('returned_verified','waived')),
  n AS (
    SELECT (SELECT count(*) FROM pc)::int pending,
           greatest(0, coalesce(v_tx.container_count, 0) - (SELECT count(*) FROM public.containers c WHERE c.transaction_id = v_tx.id))::int missing,
           (SELECT count(*) FROM public.containers c WHERE c.transaction_id = v_tx.id)::int total)
  SELECT jsonb_build_object(
    'transaction_id', v_tx.id, 'ref', v_tx.ref, 'operational_status', v_tx.operational_status, 'cargo_unit_type', v_tx.cargo_unit_type,
    'policy', jsonb_build_object('empty_return_blocks_billing', app.empty_return_blocks_billing(v_tx.org_id), 'switchable', false),
    'containers_total', n.total, 'pending_count', n.pending, 'declared_missing', n.missing,
    'pending_containers', coalesce((SELECT jsonb_agg(jsonb_build_object('container_id', pc.id, 'container_no', pc.container_no,
                                       'return_status', pc.return_status, 'return_deadline', pc.return_deadline, 'overdue', pc.overdue,
                                       'proofs_pending', pc.proofs_pending) ORDER BY pc.container_no) FROM pc), '[]'::jsonb),
    'billing_gate_open', NOT app.empty_return_blocks_billing(v_tx.org_id) OR (n.pending = 0 AND n.missing = 0),
    'blocking', CASE WHEN app.empty_return_blocks_billing(v_tx.org_id) AND (n.pending > 0 OR n.missing > 0)
                     THEN 'containers_not_returned' END,
    'proofs', (SELECT jsonb_build_object('pending_review', count(*) FILTER (WHERE p.status = 'pending_review'),
                                         'unreadable', count(*) FILTER (WHERE p.status = 'unreadable'),
                                         'approved', count(*) FILTER (WHERE p.status = 'approved'))
                 FROM public.empty_return_proofs p WHERE p.transaction_id = v_tx.id),
    'movements', (SELECT count(*) FROM public.transport_trips r WHERE r.transaction_id = v_tx.id AND r.status <> 'cancelled'),
    'carrier_order', CASE WHEN v_tx.transport_mode = 'carrier_order' THEN jsonb_build_object(
                       'order_no', v_tx.transport_order_no, 'order_date', v_tx.transport_order_date, 'party_id', v_tx.transport_party_id,
                       'party_name', (SELECT pa.name_ar FROM public.parties pa WHERE pa.id = v_tx.transport_party_id),
                       'bypasses_empty_return', false) END)
    FROM n
$$;

-- a cancelled appointment voids its card link (the card may be read again); a reschedule moves the link to the new slot
CREATE OR REPLACE FUNCTION app.tg_appointments_card_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.rescheduled_from_id IS NOT NULL THEN
      UPDATE public.appointment_draft_cards c SET appointment_id = NEW.id
       WHERE c.appointment_id = NEW.rescheduled_from_id AND c.link_voided_at IS NULL;
    END IF;
  ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.appointment_draft_cards c SET link_voided_at = now(), link_void_reason = 'appointment_cancelled'
     WHERE c.appointment_id = NEW.id AND c.link_voided_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_appt_link ON public.port_appointments;
CREATE TRIGGER trg_legacy_appt_link AFTER INSERT OR UPDATE OF status ON public.port_appointments
  FOR EACH ROW EXECUTE FUNCTION app.tg_appointments_card_link();

-- a cancelled transaction cancels its open drafts (their cards are released; legacy HF10 orphaned cards)
CREATE OR REPLACE FUNCTION app.tg_transactions_appt_drafts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL THEN
    UPDATE public.appointment_draft_cards c SET status = 'cancelled'
     WHERE c.status IN ('pending','failed')
       AND c.batch_id IN (SELECT d.id FROM public.appointment_drafts d WHERE d.transaction_id = NEW.id AND d.status IN ('pending','partial'));
    UPDATE public.appointment_drafts d SET status = 'cancelled', closed_at = now(), closed_by = auth.uid(),
           close_reason = 'transaction_cancelled', version = d.version + 1
     WHERE d.transaction_id = NEW.id AND d.status IN ('pending','partial');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_legacy_appt_drafts ON public.transactions;
CREATE TRIGGER trg_legacy_appt_drafts AFTER UPDATE OF cancelled_at ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_appt_drafts();

-- ---------------------------------------------------------------------
-- 5. RPCs — appointment drafts
-- ---------------------------------------------------------------------
-- appointment_card_state(p_org, p_tx, p_sha256s) — before reading cards (legacy fingerprint check across all transactions):
-- per SHA-256 → {sha256, state free | pending | approved | released, same_transaction, card_id, batch_id, transaction_id,
-- ref (only when the caller may read that transaction), can_move (pending in another transaction's batch the caller may move
-- here: no approved card), appointment_id}. Staff of p_org; ≤ 20 hashes.
CREATE OR REPLACE FUNCTION public.appointment_card_state(p_org uuid, p_tx uuid, p_sha256s text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_out jsonb := '[]'::jsonb; s text; v jsonb; v_t uuid; v_vis boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF p_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = p_tx AND t.org_id = p_org
                                       AND app.has_tx_role(t.id, app.staff_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'transaction');
  END IF;
  IF p_sha256s IS NULL OR cardinality(p_sha256s) > 20 THEN PERFORM app.fail('MRS_APPT_DRAFT_LIMIT', 'cards'); END IF;
  FOREACH s IN ARRAY p_sha256s LOOP
    s := lower(btrim(coalesce(s, '')));
    IF s !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', 'sha256'); END IF;
    v := app.appointment_fingerprint_state(p_org, s);
    v_t := (v ->> 'transaction_id')::uuid;
    v_vis := v_t IS NOT NULL AND app.has_tx_role(v_t, app.staff_roles());
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'sha256', s, 'state', v ->> 'state', 'same_transaction', v_t IS NOT NULL AND v_t = p_tx,
      'card_id', CASE WHEN v_vis THEN v -> 'card_id' END, 'batch_id', CASE WHEN v_vis THEN v -> 'batch_id' END,
      'transaction_id', CASE WHEN v_vis THEN v -> 'transaction_id' END,
      'ref', CASE WHEN v_vis THEN (SELECT to_jsonb(t.ref) FROM public.transactions t WHERE t.id = v_t) END,
      'appointment_id', CASE WHEN v_vis THEN v -> 'appointment_id' END,
      'can_move', v ->> 'state' = 'pending' AND v_vis AND v_t IS DISTINCT FROM p_tx AND p_tx IS NOT NULL
                  AND app.has_tx_role(v_t, app.transport_writer_roles()) AND app.has_tx_role(p_tx, app.transport_writer_roles())
                  AND EXISTS (SELECT 1 FROM public.appointment_drafts d WHERE d.id = (v ->> 'batch_id')::uuid AND d.status = 'pending')));
  END LOOP;
  RETURN v_out;
END $$;

-- save_appointment_draft(p_tx, {batch_id?, version?, note?, cards?: [{card_id? (an existing card) | source_sha256 + file_name +
--   file_size + media_type? + extraction_id? + document_id? + reading? (a new card), review?, status? pending | discarded}]})
--   — legacy persistAppointmentDraftBatchR1213_ / saveAppointmentDraftReviewR1213 (autosave): a transport writer of the
--   transaction's branch creates the transaction's open batch (no batch_id; an open one already there → MRS_APPT_DRAFT_EXISTS:
--   restore it with get_appointment_draft) or updates it (batch_id; version when given must match: MRS_APPT_DRAFT_STALE).
--   A new card's file must be free across the org (app.appointment_fingerprint_state): approved → MRS_APPT_CARD_DUPLICATE
--   approved; pending in another batch → MRS_APPT_CARD_DUPLICATE pending_other (offer move_appointment_draft); the same file
--   twice in this batch is kept once (while that card is live: pending / failed / discarded; a file released by a cancelled
--   appointment may be read again into the same batch). ≤ 20 live cards and 25 MB (MRS_APPT_DRAFT_LIMIT cards | size). The
--   reading is stored as read (a DRAFT); its extraction must be the org's, of this transaction or of none. The review
--   replaces the previous review of the card; cost / sell in a review need a trip-finance role, and the cost / sell a
--   trip-finance user entered are KEPT when another role saves the review (that role never sees nor sends them).
--   An approved / skipped card is final. → the batch (app.appt_draft_json; version + 1)
CREATE OR REPLACE FUNCTION public.save_appointment_draft(p_tx uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_tx public.transactions; d public.appointment_drafts; c public.appointment_draft_cards;
  x jsonb; v_sha text; v_st jsonb; v_ext public.document_extractions; v_doc public.documents; v_fin boolean; v_seq int;
  v_status text; v_n int; v_bytes bigint; v_batch uuid; v_changed boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['batch_id','version','note','cards']);
  v_tx := app.g3_lock_tx(p_tx, app.transport_writer_roles());
  v_fin := app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.trip_finance_roles());
  v_batch := app.puuid(p, 'batch_id');
  IF v_batch IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.appointment_drafts x2 WHERE x2.transaction_id = v_tx.id AND x2.status IN ('pending','partial')) THEN
      PERFORM app.fail('MRS_APPT_DRAFT_EXISTS');
    END IF;
    INSERT INTO public.appointment_drafts (org_id, transaction_id, note, created_by, updated_by)
    VALUES (v_tx.org_id, v_tx.id, app.ptext(p, 'note', 1000), auth.uid(), auth.uid()) RETURNING * INTO d;
  ELSE
    SELECT * INTO d FROM public.appointment_drafts x2 WHERE x2.id = v_batch FOR UPDATE;
    IF d.id IS NULL OR d.transaction_id <> v_tx.id THEN PERFORM app.fail('MRS_NOT_FOUND', 'appointment_draft'); END IF;
    IF d.status NOT IN ('pending','partial') THEN PERFORM app.fail('MRS_APPT_DRAFT_CLOSED', d.status); END IF;
    IF p ? 'version' AND jsonb_typeof(p -> 'version') <> 'null' THEN
      IF jsonb_typeof(p -> 'version') <> 'number' OR (p ->> 'version')::numeric <> d.version THEN PERFORM app.fail('MRS_APPT_DRAFT_STALE'); END IF;
    END IF;
    IF p ? 'note' THEN UPDATE public.appointment_drafts x2 SET note = app.ptext(p, 'note', 1000) WHERE x2.id = d.id; END IF;
  END IF;

  IF p ? 'cards' THEN
    IF jsonb_typeof(p -> 'cards') <> 'array' OR jsonb_array_length(p -> 'cards') > 40 THEN PERFORM app.fail('MRS_INVALID', 'cards'); END IF;
    FOR x IN SELECT y FROM jsonb_array_elements(p -> 'cards') y LOOP
      IF jsonb_typeof(x) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'cards'); END IF;
      PERFORM app.only_keys(x, ARRAY['card_id','source_sha256','file_name','file_size','media_type','extraction_id','document_id',
                                     'reading','review','status']);
      IF x ? 'review' THEN
        PERFORM app.appt_review_check(x -> 'review');
        IF NOT v_fin AND ((x -> 'review') ? 'cost_amount' OR (x -> 'review') ? 'sell_amount') THEN PERFORM app.fail('MRS_FORBIDDEN', 'cost'); END IF;
      END IF;
      v_status := app.ptext(x, 'status', 20);
      IF v_status IS NOT NULL AND v_status NOT IN ('pending','discarded') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
      IF app.puuid(x, 'card_id') IS NOT NULL THEN
        SELECT * INTO c FROM public.appointment_draft_cards y WHERE y.id = app.puuid(x, 'card_id') AND y.batch_id = d.id FOR UPDATE;
        IF c.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'card'); END IF;
        v_sha := c.source_sha256;
      ELSE
        c := NULL;
        v_sha := lower(coalesce(app.ptext(x, 'source_sha256', 64), ''));
        IF v_sha !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', 'source_sha256'); END IF;
      END IF;
      -- the reading row: the org's, an appointment card reading of the same file, not voided
      IF app.puuid(x, 'extraction_id') IS NOT NULL THEN
        SELECT * INTO v_ext FROM public.document_extractions e WHERE e.id = app.puuid(x, 'extraction_id');
        IF v_ext.id IS NULL OR v_ext.org_id <> v_tx.org_id OR v_ext.voided_at IS NOT NULL OR v_ext.doc_type <> 'appointment'
           OR v_ext.source_sha256 <> v_sha OR (v_ext.transaction_id IS NOT NULL AND v_ext.transaction_id <> v_tx.id) THEN
          PERFORM app.fail('MRS_INVALID', 'extraction_id');
        END IF;
      END IF;
      -- the card file: a live document of this transaction with the same hash
      IF app.puuid(x, 'document_id') IS NOT NULL THEN
        SELECT * INTO v_doc FROM public.documents dd WHERE dd.id = app.puuid(x, 'document_id');
        IF v_doc.id IS NULL OR v_doc.transaction_id IS DISTINCT FROM v_tx.id OR v_doc.voided_at IS NOT NULL OR v_doc.sha256 <> v_sha THEN
          PERFORM app.fail('MRS_INVALID', 'document_id');
        END IF;
      END IF;
      IF c.id IS NOT NULL THEN
        -- an existing card of this batch: the review (autosave) and / or discard / restore; the reading / document link once
        IF x ? 'source_sha256' OR x ? 'reading' OR x ? 'file_name' OR x ? 'file_size' OR x ? 'media_type' THEN PERFORM app.fail('MRS_IMMUTABLE', 'card'); END IF;
        IF c.status IN ('approved','skipped','cancelled') THEN PERFORM app.fail('MRS_IMMUTABLE', c.status); END IF;
        IF (app.puuid(x, 'extraction_id') IS NOT NULL AND c.extraction_id IS NOT NULL AND c.extraction_id <> app.puuid(x, 'extraction_id'))
           OR (app.puuid(x, 'document_id') IS NOT NULL AND c.document_id IS NOT NULL AND c.document_id <> app.puuid(x, 'document_id')) THEN
          PERFORM app.fail('MRS_IMMUTABLE', 'card');
        END IF;
        IF v_status = 'pending' AND c.status = 'discarded' THEN
          v_st := app.appointment_fingerprint_state(v_tx.org_id, c.source_sha256);
          IF v_st ->> 'state' IN ('approved','pending') THEN PERFORM app.fail('MRS_APPT_CARD_DUPLICATE', v_st ->> 'state'); END IF;
        END IF;
        UPDATE public.appointment_draft_cards y SET
          -- a role without trip finance never holds the amounts: the stored cost / sell stay on its review
          review = CASE WHEN NOT (x ? 'review') THEN y.review
                        WHEN v_fin THEN x -> 'review'
                        ELSE (x -> 'review') || coalesce((SELECT jsonb_object_agg(k, y.review -> k) FROM unnest(ARRAY['cost_amount','sell_amount']) k
                                                           WHERE y.review ? k), '{}'::jsonb) END,
          status = CASE WHEN v_status = 'discarded' THEN 'discarded' WHEN v_status = 'pending' AND y.status = 'discarded' THEN 'pending'
                        ELSE y.status END,
          extraction_id = coalesce(y.extraction_id, app.puuid(x, 'extraction_id')),
          document_id = coalesce(y.document_id, app.puuid(x, 'document_id'))
         WHERE y.id = c.id RETURNING * INTO c;
      ELSE
        -- a new card
        IF EXISTS (SELECT 1 FROM public.appointment_draft_cards y WHERE y.batch_id = d.id AND y.source_sha256 = v_sha
                      AND y.status IN ('pending','failed','discarded')) THEN
          CONTINUE;                                                     -- the same file twice in this batch: kept once
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('mrs_apptcard:' || v_tx.org_id::text || ':' || v_sha, 0));
        v_st := app.appointment_fingerprint_state(v_tx.org_id, v_sha);
        IF v_st ->> 'state' = 'approved' THEN PERFORM app.fail('MRS_APPT_CARD_DUPLICATE', 'approved'); END IF;
        IF v_st ->> 'state' = 'pending' THEN PERFORM app.fail('MRS_APPT_CARD_DUPLICATE', 'pending_other'); END IF;
        IF app.ptext(x, 'file_name', 255) IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'file_name'); END IF;
        IF jsonb_typeof(x -> 'file_size') IS DISTINCT FROM 'number' OR (x ->> 'file_size')::numeric <= 0 OR (x ->> 'file_size')::numeric > 10485760
           OR (x ->> 'file_size')::numeric <> trunc((x ->> 'file_size')::numeric) THEN
          PERFORM app.fail('MRS_INVALID', 'file_size');
        END IF;
        IF app.ptext(x, 'media_type', 40) IS NOT NULL
           AND app.ptext(x, 'media_type', 40) NOT IN ('image/jpeg','image/png','image/webp','image/gif','application/pdf') THEN
          PERFORM app.fail('MRS_INVALID', 'media_type');
        END IF;
        IF x ? 'reading' AND jsonb_typeof(x -> 'reading') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'reading'); END IF;
        IF x ? 'reading' AND octet_length((x -> 'reading')::text) > 60000 THEN PERFORM app.fail('MRS_TOO_LONG', 'reading'); END IF;
        SELECT coalesce(max(y.seq), 0) + 1 INTO v_seq FROM public.appointment_draft_cards y WHERE y.batch_id = d.id;
        INSERT INTO public.appointment_draft_cards (org_id, batch_id, seq, file_name, file_size, media_type, source_sha256, extraction_id,
                                                    document_id, origin_transaction_id, reading, review, status, created_by)
        VALUES (v_tx.org_id, d.id, v_seq, app.ptext(x, 'file_name', 255), (x ->> 'file_size')::bigint, app.ptext(x, 'media_type', 40),
                v_sha, app.puuid(x, 'extraction_id'), app.puuid(x, 'document_id'), v_tx.id, coalesce(x -> 'reading', '{}'::jsonb),
                coalesce(x -> 'review', '{}'::jsonb), CASE WHEN v_status = 'discarded' THEN 'discarded' ELSE 'pending' END, auth.uid())
        RETURNING * INTO c;
      END IF;
      v_changed := true;
    END LOOP;
    -- the batch limits (legacy: ≤ 20 cards, 25 MB per transaction)
    SELECT count(*), coalesce(sum(y.file_size), 0) INTO v_n, v_bytes FROM public.appointment_draft_cards y
     WHERE y.batch_id = d.id AND y.status NOT IN ('discarded','cancelled');
    IF v_n > 20 THEN PERFORM app.fail('MRS_APPT_DRAFT_LIMIT', 'cards'); END IF;
    IF v_bytes > 26214400 THEN PERFORM app.fail('MRS_APPT_DRAFT_LIMIT', 'size'); END IF;
  END IF;
  IF v_batch IS NOT NULL THEN
    UPDATE public.appointment_drafts x2 SET version = x2.version + 1, updated_by = auth.uid() WHERE x2.id = d.id RETURNING * INTO d;
  END IF;
  RETURN app.appt_draft_json(d);
END $$;

-- get_appointment_draft(p_tx, p_batch) — restore without a re-read (legacy getPendingAppointmentDraftR1213): the open batch of
-- the transaction (p_batch NULL; null when none) or the given batch of that transaction (any status). Staff of the branch.
CREATE OR REPLACE FUNCTION public.get_appointment_draft(p_tx uuid, p_batch uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.appointment_drafts;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_tx IS NULL OR NOT app.has_tx_role(p_tx, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF p_batch IS NULL THEN
    SELECT * INTO d FROM public.appointment_drafts x WHERE x.transaction_id = p_tx AND x.status IN ('pending','partial');
  ELSE
    SELECT * INTO d FROM public.appointment_drafts x WHERE x.id = p_batch AND x.transaction_id = p_tx;
    IF d.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'appointment_draft'); END IF;
  END IF;
  IF d.id IS NULL THEN RETURN NULL; END IF;
  RETURN app.appt_draft_json(d);
END $$;

-- cancel_appointment_draft(p_batch, p_reason) — legacy cancelAppointmentDraftR1213: a pending batch (no approved card) is
-- cancelled with the reason; its cards are released for a new read. Partly approved / approved → MRS_APPT_DRAFT_APPROVED.
CREATE OR REPLACE FUNCTION public.cancel_appointment_draft(p_batch uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.appointment_drafts; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_n int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  d := app.appt_draft_lock(p_batch);
  IF d.status IN ('partial','approved') THEN PERFORM app.fail('MRS_APPT_DRAFT_APPROVED'); END IF;
  IF d.status <> 'pending' THEN PERFORM app.fail('MRS_APPT_DRAFT_CLOSED', d.status); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  UPDATE public.appointment_draft_cards c SET status = 'cancelled' WHERE c.batch_id = d.id AND c.status IN ('pending','failed','discarded');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.appointment_drafts x SET status = 'cancelled', closed_at = now(), closed_by = auth.uid(), close_reason = v_reason,
         version = x.version + 1, updated_by = auth.uid()
   WHERE x.id = d.id RETURNING * INTO d;
  RETURN app.appt_draft_json(d) || jsonb_build_object('released_cards', v_n);
END $$;

-- move_appointment_draft(p_batch, p_target_ref, p_reason) — legacy moveAppointmentDraftR1213: a pending batch (no approved
-- card) goes to another transaction of the org given by its number (ref), which the caller may write. The batch moves (its
-- transaction changes, moved_from kept); when the target already has an open batch the cards join it (≤ 20 / 25 MB) and this
-- batch closes as 'moved'; the same file as a live card of the target's batch → MRS_APPT_CARD_DUPLICATE pending (a
-- discarded card there gives way). The reviewed container choice is cleared (it named the first transaction's container;
-- approval matches the card's number against the target's containers). Legacy moveAppointmentDraftR1213 re-points the
-- unapproved card documents; here a document's storage path is bound to its transaction, so a card file stays on the
-- transaction it was read on (origin_transaction_id) unless the target already holds the same file (the card then points
-- at that one); the approved movement still links the card file / reading of the origin. An event on both transactions.
-- → the target batch (app.appt_draft_json)
CREATE OR REPLACE FUNCTION public.move_appointment_draft(p_batch uuid, p_target_ref text, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.appointment_drafts; t public.transactions; v_src public.transactions; v_ref text := upper(btrim(coalesce(p_target_ref, '')));
  v_open public.appointment_drafts; v_n int; v_bytes bigint; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_seq int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  d := app.appt_draft_lock(p_batch);
  IF d.status IN ('partial','approved') THEN PERFORM app.fail('MRS_APPT_DRAFT_APPROVED'); END IF;
  IF d.status <> 'pending' THEN PERFORM app.fail('MRS_APPT_DRAFT_CLOSED', d.status); END IF;
  IF v_ref = '' THEN PERFORM app.fail('MRS_REQUIRED', 'target_ref'); END IF;
  SELECT * INTO v_src FROM public.transactions x WHERE x.id = d.transaction_id;
  SELECT * INTO t FROM public.transactions x WHERE x.org_id = d.org_id AND upper(x.ref) = v_ref;
  IF t.id IS NULL OR NOT app.has_tx_role(t.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF t.id = d.transaction_id THEN PERFORM app.fail('MRS_INVALID', 'same_transaction'); END IF;
  t := app.g3_lock_tx(t.id, app.transport_writer_roles());
  SELECT * INTO v_open FROM public.appointment_drafts x WHERE x.transaction_id = t.id AND x.status IN ('pending','partial') FOR UPDATE;
  -- the same file in the target's open batch: a live card there → refused; a discarded one gives way (cancelled)
  IF v_open.id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.appointment_draft_cards s
                 JOIN public.appointment_draft_cards o ON o.batch_id = v_open.id AND o.source_sha256 = s.source_sha256 AND o.status IN ('pending','failed')
                WHERE s.batch_id = d.id AND s.status IN ('pending','failed')) THEN
      PERFORM app.fail('MRS_APPT_CARD_DUPLICATE', 'pending');
    END IF;
    UPDATE public.appointment_draft_cards o SET status = 'cancelled'
     WHERE o.batch_id = v_open.id AND o.status = 'discarded'
       AND o.source_sha256 IN (SELECT s.source_sha256 FROM public.appointment_draft_cards s WHERE s.batch_id = d.id AND s.status IN ('pending','failed'));
  END IF;
  -- the card files: a document's storage path is bound to its transaction (documents_path_chk), so the file stays where
  -- it was uploaded; when the target already holds the same file (the target page uploads it before a move-here) the
  -- card points at that document. Approval links the card's file / reading of its origin transaction otherwise.
  UPDATE public.appointment_draft_cards y SET document_id = (
           SELECT dd.id FROM public.documents dd WHERE dd.org_id = d.org_id AND dd.transaction_id = t.id AND dd.voided_at IS NULL
              AND dd.sha256 = y.source_sha256 ORDER BY dd.uploaded_at, dd.id LIMIT 1)
   WHERE y.batch_id = d.id AND y.status NOT IN ('discarded','cancelled')
     AND EXISTS (SELECT 1 FROM public.documents dd WHERE dd.org_id = d.org_id AND dd.transaction_id = t.id AND dd.voided_at IS NULL
                    AND dd.sha256 = y.source_sha256);
  IF v_open.id IS NULL THEN
    UPDATE public.appointment_drafts x SET transaction_id = t.id, moved_from_transaction_id = d.transaction_id,
           version = x.version + 1, updated_by = auth.uid()
     WHERE x.id = d.id RETURNING * INTO v_open;
    UPDATE public.appointment_draft_cards c SET review = c.review - 'container_id' WHERE c.batch_id = d.id AND c.review ? 'container_id';
  ELSE
    SELECT count(*), coalesce(sum(c.file_size), 0) INTO v_n, v_bytes FROM public.appointment_draft_cards c
     WHERE c.batch_id IN (d.id, v_open.id) AND c.status NOT IN ('discarded','cancelled');
    IF v_n > 20 THEN PERFORM app.fail('MRS_APPT_DRAFT_LIMIT', 'cards'); END IF;
    IF v_bytes > 26214400 THEN PERFORM app.fail('MRS_APPT_DRAFT_LIMIT', 'size'); END IF;
    SELECT coalesce(max(c.seq), 0) INTO v_seq FROM public.appointment_draft_cards c WHERE c.batch_id = v_open.id;
    UPDATE public.appointment_draft_cards c SET batch_id = v_open.id, seq = v_seq + c.seq, review = c.review - 'container_id'
     WHERE c.batch_id = d.id AND c.status NOT IN ('discarded','cancelled');
    UPDATE public.appointment_draft_cards c SET status = 'cancelled' WHERE c.batch_id = d.id AND c.status = 'discarded';
    UPDATE public.appointment_drafts x SET status = 'moved', moved_to_batch_id = v_open.id, closed_at = now(), closed_by = auth.uid(),
           close_reason = coalesce(v_reason, 'moved'), version = x.version + 1, updated_by = auth.uid()
     WHERE x.id = d.id;
    UPDATE public.appointment_drafts x SET version = x.version + 1, updated_by = auth.uid() WHERE x.id = v_open.id RETURNING * INTO v_open;
  END IF;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload) VALUES
    (d.org_id, d.transaction_id, 'appointment', v_reason, false, auth.uid(),
     jsonb_build_object('op', 'draft_moved_out', 'batch_id', d.id, 'to_transaction_id', t.id, 'to_ref', t.ref)),
    (d.org_id, t.id, 'appointment', v_reason, false, auth.uid(),
     jsonb_build_object('op', 'draft_moved_in', 'batch_id', v_open.id, 'from_batch_id', d.id, 'from_transaction_id', v_src.id,
                        'from_ref', v_src.ref));
  RETURN app.appt_draft_json(v_open);
END $$;

-- approve_appointment_draft(p_batch, {version?, card_ids? (default: every pending / failed card), idempotencyKey?}) — legacy
-- saveReviewedAppointments + markAppointmentDraftApprovedR1213: a transport writer approves the reviewed cards one by one
-- (each in its own sub-transaction: a refused card never undoes another). Per card → saved | already_existed (the movement
-- was there: save_movement idempotent) | skipped (not a full-exit card: no movement) | failed (code + detail; the card
-- stays editable for a retry). The batch becomes approved when no card is left to approve, else partial (partial
-- approval). Audited (the cards / batch rows and the appointment / trip events). Idempotent with the key.
-- → {batch_id, status, results [{card_id, seq, file_name, outcome, code, detail, appointment_id, trip_id}], counts {saved,
--    already_existed, skipped, failed}, batch (app.appt_draft_json), readiness}
CREATE OR REPLACE FUNCTION public.approve_appointment_draft(p_batch uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); d public.appointment_drafts; v_tx public.transactions; c public.appointment_draft_cards;
  v_key uuid; v_replay jsonb; v_ids uuid[]; v_r jsonb; v_out jsonb := '[]'::jsonb; v_code text; v_detail text; v_res jsonb;
  v_left int; v_done int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['version','card_ids','idempotencyKey']);
  d := app.appt_draft_lock(p_batch);
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = d.transaction_id;
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('approve_appointment_draft', v_key, jsonb_build_object('batch', p_batch, 'p', p - 'idempotencyKey'), d.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF d.status NOT IN ('pending','partial') THEN PERFORM app.fail('MRS_APPT_DRAFT_CLOSED', d.status); END IF;
  IF p ? 'version' AND jsonb_typeof(p -> 'version') <> 'null' THEN
    IF jsonb_typeof(p -> 'version') <> 'number' OR (p ->> 'version')::numeric <> d.version THEN PERFORM app.fail('MRS_APPT_DRAFT_STALE'); END IF;
  END IF;
  IF p ? 'card_ids' AND jsonb_typeof(p -> 'card_ids') <> 'null' THEN
    IF jsonb_typeof(p -> 'card_ids') <> 'array' OR jsonb_array_length(p -> 'card_ids') > 20
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'card_ids') z
                   WHERE jsonb_typeof(z) <> 'string' OR (z #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      PERFORM app.fail('MRS_INVALID', 'card_ids');
    END IF;
    v_ids := ARRAY(SELECT (z #>> '{}')::uuid FROM jsonb_array_elements(p -> 'card_ids') z);
    IF EXISTS (SELECT 1 FROM unnest(v_ids) i WHERE NOT EXISTS (SELECT 1 FROM public.appointment_draft_cards y WHERE y.id = i AND y.batch_id = d.id)) THEN
      PERFORM app.fail('MRS_NOT_FOUND', 'card');
    END IF;
  END IF;
  FOR c IN SELECT * FROM public.appointment_draft_cards y
            WHERE y.batch_id = d.id AND y.status IN ('pending','failed') AND (v_ids IS NULL OR y.id = ANY (v_ids))
            ORDER BY y.seq, y.created_at FOR UPDATE LOOP
    v_code := NULL; v_detail := NULL; v_r := NULL;
    BEGIN
      v_r := app.appt_card_approve(v_tx, c);
    EXCEPTION WHEN OTHERS THEN
      v_code := CASE WHEN SQLERRM ~ '^MRS_[A-Z_]+$' THEN SQLERRM ELSE 'MRS_INVALID' END;
      GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
      v_detail := left(nullif(v_detail, ''), 200);
    END;
    IF v_code IS NULL THEN
      UPDATE public.appointment_draft_cards y SET
        status = CASE WHEN v_r ->> 'outcome' = 'skipped' THEN 'skipped' ELSE 'approved' END,
        appointment_id = (v_r ->> 'appointment_id')::uuid, trip_id = (v_r ->> 'trip_id')::uuid,
        approved_by = CASE WHEN v_r ->> 'outcome' = 'skipped' THEN NULL ELSE auth.uid() END,
        approved_at = CASE WHEN v_r ->> 'outcome' = 'skipped' THEN NULL ELSE now() END,
        result = jsonb_build_object('outcome', v_r ->> 'outcome', 'appointment_id', v_r -> 'appointment_id', 'trip_id', v_r -> 'trip_id',
                                    'at', now(), 'by', auth.uid())
       WHERE y.id = c.id;
      IF v_r ->> 'outcome' <> 'skipped' THEN
        INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, actor, payload)
        VALUES (d.org_id, d.transaction_id, 'appointment', false, auth.uid(),
                jsonb_build_object('op', 'card_approved', 'outcome', v_r ->> 'outcome', 'batch_id', d.id, 'card_id', c.id,
                                   'appointment_id', v_r -> 'appointment_id'));
      END IF;
    ELSE
      UPDATE public.appointment_draft_cards y SET status = 'failed',
             result = jsonb_build_object('outcome', 'failed', 'code', v_code, 'detail', v_detail, 'at', now(), 'by', auth.uid())
       WHERE y.id = c.id;
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object('card_id', c.id, 'seq', c.seq, 'file_name', c.file_name,
      'outcome', coalesce(v_r ->> 'outcome', 'failed'), 'code', v_code, 'detail', v_detail,
      'appointment_id', v_r -> 'appointment_id', 'trip_id', v_r -> 'trip_id'));
  END LOOP;
  SELECT count(*) FILTER (WHERE y.status IN ('pending','failed')), count(*) FILTER (WHERE y.status IN ('approved','skipped'))
    INTO v_left, v_done FROM public.appointment_draft_cards y WHERE y.batch_id = d.id;
  UPDATE public.appointment_drafts x SET
    status = CASE WHEN v_left = 0 AND v_done > 0 THEN 'approved'
                  WHEN EXISTS (SELECT 1 FROM public.appointment_draft_cards y WHERE y.batch_id = d.id AND y.status = 'approved') THEN 'partial'
                  ELSE x.status END,
    closed_at = CASE WHEN v_left = 0 AND v_done > 0 THEN now() END,
    closed_by = CASE WHEN v_left = 0 AND v_done > 0 THEN auth.uid() END,
    version = x.version + 1, updated_by = auth.uid()
   WHERE x.id = d.id RETURNING * INTO d;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = d.transaction_id;
  v_res := jsonb_build_object('batch_id', d.id, 'status', d.status, 'results', v_out,
    'counts', jsonb_build_object(
      'saved', (SELECT count(*) FROM jsonb_array_elements(v_out) z WHERE z ->> 'outcome' = 'saved'),
      'already_existed', (SELECT count(*) FROM jsonb_array_elements(v_out) z WHERE z ->> 'outcome' = 'already_existed'),
      'skipped', (SELECT count(*) FROM jsonb_array_elements(v_out) z WHERE z ->> 'outcome' = 'skipped'),
      'failed', (SELECT count(*) FROM jsonb_array_elements(v_out) z WHERE z ->> 'outcome' = 'failed')),
    'batch', app.appt_draft_json(d), 'readiness', app.tx_readiness_of(v_tx));
  RETURN app.idem_finish('approve_appointment_draft', v_key, v_res);
END $$;

-- ---------------------------------------------------------------------
-- 5. RPCs — empty-return proofs
-- ---------------------------------------------------------------------
-- create_empty_return_proof(p_tx, {document_id (required: a live document of the transaction, PDF / image ≤ 8 MB),
--   source 'ai' | 'manual' (default manual), extraction_id? (an empty_return_receipt reading of the same file), container_id? |
--   container_no?, delivered_at? (date WITH time; no offset = Riyadh; a date alone → MRS_DATETIME_REQUIRED), depot?,
--   confidence? 0..1, match_notes?, unreadable? (the reading failed), idempotencyKey?}) — legacy
--   analyzeAndSaveEmptyReturnProofR12110 WITHOUT its auto-apply (owner decision): the proof is registered as pending_review
--   (or unreadable), never approved here, and the container is not touched. Values left out are taken from the reading. The
--   container must be one of the transaction's (a number that is not → kept as read, container_id null, a match note).
--   A transport writer of the branch. → the proof (app.erp_json) + {container_matched}
CREATE OR REPLACE FUNCTION public.create_empty_return_proof(p_tx uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_tx public.transactions; v_key uuid; v_replay jsonb; v_doc public.documents;
  v_ext public.document_extractions; v_src text; v_no text; v_ctr uuid; v_at timestamptz; v_depot text; v_conf numeric;
  v_notes text[] := '{}'; v_status text := 'pending_review'; r public.empty_return_proofs; v_s text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['document_id','source','extraction_id','container_id','container_no','delivered_at','depot','confidence',
                                 'match_notes','unreadable','idempotencyKey']);
  v_tx := app.g3_lock_tx(p_tx, app.transport_writer_roles());
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('create_empty_return_proof', v_key, jsonb_build_object('transaction', p_tx, 'p', p - 'idempotencyKey'), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_src := coalesce(app.ptext(p, 'source', 10), 'manual');
  IF v_src NOT IN ('ai','manual') THEN PERFORM app.fail('MRS_INVALID', 'source'); END IF;
  -- the proof file (legacy: PDF or image ≤ 8 MB, kept)
  IF app.puuid(p, 'document_id') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'document_id'); END IF;
  SELECT * INTO v_doc FROM public.documents dd WHERE dd.id = app.puuid(p, 'document_id');
  IF v_doc.id IS NULL OR v_doc.transaction_id IS DISTINCT FROM v_tx.id OR v_doc.voided_at IS NOT NULL THEN
    PERFORM app.fail('MRS_INVALID', 'document_id');
  END IF;
  IF v_doc.size_bytes > 8388608 OR coalesce(v_doc.mime_type, '') NOT IN ('application/pdf','image/jpeg','image/png','image/webp','image/gif') THEN
    PERFORM app.fail('MRS_EMPTY_RETURN_FILE', CASE WHEN v_doc.size_bytes > 8388608 THEN 'size' ELSE 'type' END);
  END IF;
  -- one open proof per file: reading or registering the same EIR again returns the existing proof (no duplicate rows)
  SELECT * INTO r FROM public.empty_return_proofs x
   WHERE x.transaction_id = v_tx.id AND x.document_id = v_doc.id AND x.status <> 'voided'
   ORDER BY x.created_at LIMIT 1;
  IF r.id IS NOT NULL THEN
    RETURN app.idem_finish('create_empty_return_proof', v_key, app.erp_json(r)
      || jsonb_build_object('container_matched', r.container_id IS NOT NULL, 'existing', true));
  END IF;
  -- the reading (optional): an EIR reading of the same file, the org's, live
  IF app.puuid(p, 'extraction_id') IS NOT NULL THEN
    SELECT * INTO v_ext FROM public.document_extractions e WHERE e.id = app.puuid(p, 'extraction_id');
    IF v_ext.id IS NULL OR v_ext.org_id <> v_tx.org_id OR v_ext.voided_at IS NOT NULL OR v_ext.doc_type <> 'empty_return_receipt'
       OR v_ext.source_sha256 <> v_doc.sha256 OR (v_ext.transaction_id IS NOT NULL AND v_ext.transaction_id <> v_tx.id) THEN
      PERFORM app.fail('MRS_INVALID', 'extraction_id');
    END IF;
    v_src := 'ai';
  END IF;
  -- the container: chosen, or by number (as given / as read)
  IF app.puuid(p, 'container_id') IS NOT NULL THEN
    SELECT c.id, c.container_no INTO v_ctr, v_no FROM public.containers c WHERE c.id = app.puuid(p, 'container_id') AND c.transaction_id = v_tx.id;
    IF v_ctr IS NULL THEN PERFORM app.fail('MRS_APPT_CONTAINER_NOT_IN_TX', 'container_id'); END IF;
  ELSE
    v_s := coalesce(app.ptext(p, 'container_no', 20), nullif(btrim(split_part(v_ext.extracted_fields ->> 'container_numbers', ',', 1)), ''),
                    nullif(btrim(v_ext.ai_detail -> 'empty_return' ->> 'container_no'), ''));
    v_no := nullif(upper(regexp_replace(app.to_western(coalesce(v_s, '')), '[^A-Za-z0-9]', '', 'g')), '');
    IF v_no IS NOT NULL AND v_no !~ '^[A-Z]{4}[0-9]{7}$' THEN
      IF p ? 'container_no' THEN PERFORM app.fail('MRS_INVALID', 'container_no'); END IF;
      v_notes := v_notes || 'container_format'::text; v_no := NULL;
    END IF;
    SELECT c.id INTO v_ctr FROM public.containers c WHERE c.transaction_id = v_tx.id AND c.container_no = v_no;
    IF v_no IS NULL THEN v_notes := v_notes || 'container_not_read'::text;
    ELSIF v_ctr IS NULL THEN v_notes := v_notes || 'container_not_in_transaction'::text; END IF;
  END IF;
  -- the delivery time (a date alone is refused); the depot; the confidence
  IF p ? 'delivered_at' THEN
    v_at := app.appt_ts(p, 'delivered_at');
  ELSIF v_ext.id IS NOT NULL AND nullif(v_ext.ai_detail -> 'empty_return' ->> 'delivered_at', '') IS NOT NULL THEN
    BEGIN
      v_at := app.appt_ts(jsonb_build_object('delivered_at', v_ext.ai_detail -> 'empty_return' ->> 'delivered_at'), 'delivered_at');
    EXCEPTION WHEN OTHERS THEN v_at := NULL;
    END;
  END IF;
  IF v_at IS NULL THEN v_notes := v_notes || 'delivery_time_missing'::text; END IF;
  IF v_at > now() + interval '1 day' THEN PERFORM app.fail('MRS_INVALID', 'delivered_at'); END IF;
  v_depot := coalesce(app.ptext(p, 'depot', 160), left(nullif(btrim(v_ext.ai_detail -> 'empty_return' ->> 'depot'), ''), 160),
                      left(nullif(btrim(v_ext.extracted_fields ->> 'return_depot'), ''), 160));
  IF v_depot IS NULL THEN v_notes := v_notes || 'depot_missing'::text; END IF;
  IF p ? 'confidence' AND jsonb_typeof(p -> 'confidence') <> 'null' THEN
    IF jsonb_typeof(p -> 'confidence') <> 'number' OR (p ->> 'confidence')::numeric NOT BETWEEN 0 AND 1 THEN PERFORM app.fail('MRS_INVALID', 'confidence'); END IF;
    v_conf := round((p ->> 'confidence')::numeric, 3);
  ELSIF v_ext.id IS NOT NULL AND jsonb_typeof(v_ext.ai_detail -> 'empty_return' -> 'confidence') = 'number' THEN
    v_conf := round((v_ext.ai_detail -> 'empty_return' ->> 'confidence')::numeric, 3);
  END IF;
  IF app.pbool(p, 'unreadable') THEN v_status := 'unreadable'; END IF;
  INSERT INTO public.empty_return_proofs (org_id, transaction_id, container_id, container_no, document_id, extraction_id, source, delivered_at,
                                          depot, confidence, status, match_notes, created_by)
  VALUES (v_tx.org_id, v_tx.id, v_ctr, v_no, v_doc.id, v_ext.id, v_src, v_at, v_depot, v_conf, v_status,
          nullif(left(concat_ws(' | ', nullif(array_to_string(v_notes, ' | '), ''), app.ptext(p, 'match_notes', 1500)), 2000), ''), auth.uid())
  RETURNING * INTO r;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, actor, payload)
  VALUES (r.org_id, r.transaction_id, 'container_return', false, auth.uid(),
          jsonb_build_object('op', 'proof_registered', 'proof_id', r.id, 'container_id', r.container_id, 'status', r.status, 'source', r.source));
  RETURN app.idem_finish('create_empty_return_proof', v_key, app.erp_json(r) || jsonb_build_object('container_matched', v_ctr IS NOT NULL));
END $$;

-- verify_empty_return_proof(p_proof, {container_id?, delivered_at?, depot?, match_notes?, idempotencyKey?}) — legacy
-- approveEmptyReturnProofR12110: a staff member (transport writer of the branch) confirms the proof. Required then: a
-- container of the transaction, the delivery date AND time, the depot. Atomic: the proof document is confirmed as an empty
-- return receipt (classification by this staff member), the container return is written through the existing evidence path
-- (return_status returned_verified + evidence_document_id + returned_at = the delivery time; the container triggers check
-- the receipt and stamp the verifier; the lifecycle moves to empty_return), the proof becomes approved. A container already
-- returned (another proof) stays as it is (container_already_returned); a waived one → MRS_BAD_TRANSITION waived.
-- → the proof + {container {id, container_no, return_status, returned_at}, container_already_returned, readiness}
CREATE OR REPLACE FUNCTION public.verify_empty_return_proof(p_proof uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); r public.empty_return_proofs; v_tx public.transactions; v_key uuid; v_replay jsonb;
  v_ctr public.containers; v_at timestamptz; v_depot text; v_doc public.documents; v_already boolean := false; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['container_id','delivered_at','depot','match_notes','idempotencyKey']);
  SELECT * INTO r FROM public.empty_return_proofs x WHERE x.id = p_proof;
  IF r.id IS NULL OR NOT app.has_tx_role(r.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'proof'); END IF;
  v_tx := app.g3_lock_tx(r.transaction_id, app.transport_writer_roles());
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('verify_empty_return_proof', v_key, jsonb_build_object('proof', p_proof, 'p', p - 'idempotencyKey'), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  SELECT * INTO r FROM public.empty_return_proofs x WHERE x.id = p_proof FOR UPDATE;
  IF r.status NOT IN ('pending_review','unreadable') THEN PERFORM app.fail('MRS_EMPTY_RETURN_CLOSED', r.status); END IF;
  IF app.puuid(p, 'container_id') IS NOT NULL THEN
    SELECT * INTO v_ctr FROM public.containers c WHERE c.id = app.puuid(p, 'container_id') AND c.transaction_id = v_tx.id FOR UPDATE;
    IF v_ctr.id IS NULL THEN PERFORM app.fail('MRS_APPT_CONTAINER_NOT_IN_TX', 'container_id'); END IF;
  ELSIF r.container_id IS NOT NULL THEN
    SELECT * INTO v_ctr FROM public.containers c WHERE c.id = r.container_id FOR UPDATE;
  ELSE
    PERFORM app.fail('MRS_REQUIRED', 'container_id');
  END IF;
  v_at := CASE WHEN p ? 'delivered_at' THEN app.appt_ts(p, 'delivered_at') ELSE r.delivered_at END;
  IF v_at IS NULL THEN PERFORM app.fail('MRS_DATETIME_REQUIRED', 'delivered_at'); END IF;
  IF v_at > now() + interval '1 day' THEN PERFORM app.fail('MRS_INVALID', 'delivered_at'); END IF;
  v_depot := CASE WHEN p ? 'depot' THEN app.ptext(p, 'depot', 160) ELSE r.depot END;
  IF v_depot IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'depot'); END IF;
  IF v_ctr.return_status = 'waived' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'waived'); END IF;
  SELECT * INTO v_doc FROM public.documents dd WHERE dd.id = r.document_id FOR UPDATE;
  IF v_doc.voided_at IS NOT NULL THEN PERFORM app.fail('MRS_EVIDENCE_INVALID', 'document_id'); END IF;
  -- the staff confirmation of the document (the receipt the container triggers require)
  IF v_doc.classification IS DISTINCT FROM 'empty_return_receipt' OR v_doc.classification_status NOT IN ('confirmed','reclassified') THEN
    UPDATE public.documents dd SET
      classification_status = CASE WHEN dd.classification IS NULL OR dd.classification = 'empty_return_receipt' THEN 'confirmed' ELSE 'reclassified' END,
      classification = 'empty_return_receipt'
     WHERE dd.id = v_doc.id;
  END IF;
  IF v_ctr.return_status = 'returned_verified' THEN
    v_already := true;
  ELSE
    UPDATE public.containers c SET evidence_document_id = v_doc.id, return_status = 'returned_verified', returned_at = v_at,
           return_location = coalesce(c.return_location, left(v_depot, 120))
     WHERE c.id = v_ctr.id RETURNING * INTO v_ctr;
  END IF;
  UPDATE public.empty_return_proofs x SET status = 'approved', container_id = v_ctr.id, container_no = v_ctr.container_no,
         delivered_at = v_at, depot = v_depot, verified_by = auth.uid(), verified_at = now(),
         match_notes = CASE WHEN p ? 'match_notes' THEN app.ptext(p, 'match_notes', 2000) ELSE x.match_notes END
   WHERE x.id = r.id RETURNING * INTO r;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, actor, payload)
  VALUES (r.org_id, r.transaction_id, 'container_return', false, auth.uid(),
          jsonb_build_object('op', 'proof_verified', 'proof_id', r.id, 'container_id', v_ctr.id, 'container_no', v_ctr.container_no,
                             'already_returned', v_already));
  IF r.extraction_id IS NOT NULL THEN
    UPDATE public.document_extractions x SET review_status = 'reviewed' WHERE x.id = r.extraction_id AND x.review_status = 'unreviewed' AND x.voided_at IS NULL;
  END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
  v_res := app.erp_json(r) || jsonb_build_object('container', jsonb_build_object('id', v_ctr.id, 'container_no', v_ctr.container_no,
             'return_status', v_ctr.return_status, 'returned_at', v_ctr.returned_at), 'container_already_returned', v_already,
             'readiness', app.tx_readiness_of(v_tx));
  RETURN app.idem_finish('verify_empty_return_proof', v_key, v_res);
END $$;

-- void_empty_return_proof(p_proof, p_reason) — legacy deleteEmptyReturnProofR12110HF7 (soft): the proof is voided with the
-- reason (the file is kept). When it was the approved proof the container's return rests on: another approved proof of the
-- container takes over (its document / time), else the container return is reverted (pending, no evidence) — refused once
-- the transaction is operationally complete or later (MRS_EMPTY_RETURN_LOCKED). Already voided → MRS_EMPTY_RETURN_CLOSED.
-- → the proof + {container_reverted, replaced_by_proof_id, readiness}
CREATE OR REPLACE FUNCTION public.void_empty_return_proof(p_proof uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.empty_return_proofs; v_tx public.transactions; v_ctr public.containers; v_other public.empty_return_proofs;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_reverted boolean := false; v_was text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.empty_return_proofs x WHERE x.id = p_proof;
  IF r.id IS NULL OR NOT app.has_tx_role(r.transaction_id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'proof'); END IF;
  v_tx := app.g3_lock_tx(r.transaction_id, app.transport_writer_roles());
  SELECT * INTO r FROM public.empty_return_proofs x WHERE x.id = p_proof FOR UPDATE;
  IF r.status = 'voided' THEN PERFORM app.fail('MRS_EMPTY_RETURN_CLOSED', 'voided'); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  v_was := r.status;
  IF r.status = 'approved' AND r.container_id IS NOT NULL THEN
    SELECT * INTO v_ctr FROM public.containers c WHERE c.id = r.container_id FOR UPDATE;
    IF v_ctr.return_status = 'returned_verified' AND v_ctr.evidence_document_id = r.document_id THEN
      SELECT * INTO v_other FROM public.empty_return_proofs x
       WHERE x.container_id = v_ctr.id AND x.status = 'approved' AND x.id <> r.id
         AND EXISTS (SELECT 1 FROM public.documents dd WHERE dd.id = x.document_id AND dd.voided_at IS NULL
                        AND dd.classification = 'empty_return_receipt' AND dd.classification_status IN ('confirmed','reclassified'))
       ORDER BY x.verified_at DESC, x.id LIMIT 1;
      IF v_other.id IS NOT NULL THEN
        IF v_other.document_id <> r.document_id THEN
          UPDATE public.containers c SET evidence_document_id = v_other.document_id, returned_at = v_other.delivered_at WHERE c.id = v_ctr.id;
        END IF;
      ELSE
        IF app.code_sort('operational_status', v_tx.operational_status) >= app.code_sort('operational_status', 'operationally_complete') THEN
          PERFORM app.fail('MRS_EMPTY_RETURN_LOCKED', v_tx.operational_status);
        END IF;
        UPDATE public.containers c SET return_status = 'pending', evidence_document_id = NULL, returned_at = NULL WHERE c.id = v_ctr.id;
        v_reverted := true;
      END IF;
    END IF;
  END IF;
  UPDATE public.empty_return_proofs x SET status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   WHERE x.id = r.id RETURNING * INTO r;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
  VALUES (r.org_id, r.transaction_id, 'container_return', v_reason, false, auth.uid(),
          jsonb_build_object('op', 'proof_voided', 'proof_id', r.id, 'container_id', r.container_id, 'was', v_was,
                             'container_reverted', v_reverted, 'replaced_by_proof_id', v_other.id));
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
  RETURN app.erp_json(r) || jsonb_build_object('container_reverted', v_reverted, 'replaced_by_proof_id', v_other.id,
                                               'readiness', app.tx_readiness_of(v_tx));
END $$;

-- save_empty_return_deadline(p_container, p_deadline) — legacy saveEmptyReturnDeadlineR12110: only the last day to return the
-- empty (a deadline, not a proof; NULL clears it), through set_container_return (the return-plan path and its event).
CREATE OR REPLACE FUNCTION public.save_empty_return_deadline(p_container uuid, p_deadline date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  RETURN public.set_container_return(p_container, jsonb_build_object('return_deadline', to_char(p_deadline, 'YYYY-MM-DD')));
END $$;

-- list_empty_return_proofs(p_tx) — the proofs of a transaction (newest first, voided included) + the readiness. Staff of the branch.
CREATE OR REPLACE FUNCTION public.list_empty_return_proofs(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  RETURN jsonb_build_object('transaction_id', v_tx.id,
    'proofs', coalesce((SELECT jsonb_agg(app.erp_json(x) ORDER BY x.created_at DESC, x.id) FROM public.empty_return_proofs x
                         WHERE x.transaction_id = v_tx.id), '[]'::jsonb),
    'readiness', app.tx_readiness_of(v_tx));
END $$;

-- ---------------------------------------------------------------------
-- 5. RPCs — TASTO carrier order, readiness
-- ---------------------------------------------------------------------
-- save_transport_carrier_order(p_tx, {order_no (^TASTO\d+$), order_date YYYY-MM-DD, party_id? (a carrier of the org) |
--   company_name? (an existing party of that name — a carrier —, else a new carrier party), idempotencyKey?}) — legacy
--   saveTransportCompanyOrder: transport handed to a company. Not before the customs release — the new / in-progress /
--   customs-declaration stages, legacy «جديد» / «نشطة» (MRS_TASTO_STAGE); the
--   number is unique among the org's live transactions (MRS_TASTO_TAKEN); the same order again → already_exists, nothing
--   written; otherwise transport_mode carrier_order + party + number + date, and an internal note event (the legacy audit
--   line). OWNER DECISION 2026-11-11: it does NOT move the transaction to under_billing and does NOT bypass the
--   empty-return proof — set_transaction_status('under_billing') still needs every container returned (the carrier's
--   EIR, verified). A transport writer of the branch. → {transaction_id, ref, operational_status, transport_mode, order_no,
--   order_date, party_id, party_name, party_created, already_exists, readiness}
CREATE OR REPLACE FUNCTION public.save_transport_carrier_order(p_tx uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v_tx public.transactions; v_key uuid; v_replay jsonb; v_no text; v_date date;
  v_party uuid; v_name text; v_pa public.parties; v_created boolean := false; v_other public.transactions; v_same boolean; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(p, ARRAY['order_no','order_date','party_id','company_name','idempotencyKey']);
  v_tx := app.g3_lock_tx(p_tx, app.transport_writer_roles());
  v_key := app.idem_key_from(p);
  v_replay := app.idem_begin('save_transport_carrier_order', v_key, jsonb_build_object('transaction', p_tx, 'p', p - 'idempotencyKey'), v_tx.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  -- legacy: not before the customs release («جديد» / «نشطة» = new / in_progress / customs_declaration)
  IF v_tx.operational_status IN ('new','in_progress','customs_declaration') THEN PERFORM app.fail('MRS_TASTO_STAGE', v_tx.operational_status); END IF;
  v_no := app.norm_code(app.ptext(p, 'order_no', 40));
  IF v_no IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'order_no'); END IF;
  IF v_no !~ '^TASTO[0-9]{1,20}$' THEN PERFORM app.fail('MRS_TASTO_INVALID', 'order_no'); END IF;
  v_date := app.pdate(p, 'order_date');
  IF v_date IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'order_date'); END IF;
  -- the company: a carrier party (chosen, or found / created by name)
  v_party := app.puuid(p, 'party_id');
  IF v_party IS NOT NULL THEN
    PERFORM app.g3_check_party(v_tx.org_id, v_party, ARRAY['carrier'], 'party_id');
  ELSE
    v_name := app.ptext(p, 'company_name', 160);
    IF v_name IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'company_name'); END IF;
    IF char_length(v_name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'company_name'); END IF;
    SELECT * INTO v_pa FROM public.parties pa WHERE pa.org_id = v_tx.org_id AND lower(pa.name_ar) = lower(v_name);
    IF v_pa.id IS NULL THEN
      INSERT INTO public.parties (org_id, kinds, name_ar, created_by) VALUES (v_tx.org_id, ARRAY['carrier'], v_name, auth.uid())
      RETURNING * INTO v_pa;
      v_created := true;
    ELSIF NOT ('carrier' = ANY (v_pa.kinds)) OR NOT v_pa.is_active THEN
      PERFORM app.fail('MRS_INVALID', 'company_name');
    END IF;
    v_party := v_pa.id;
  END IF;
  SELECT pa.name_ar INTO v_name FROM public.parties pa WHERE pa.id = v_party;
  -- the number: one live transaction of the org (the partial unique index is the race backstop)
  SELECT * INTO v_other FROM public.transactions t
   WHERE t.org_id = v_tx.org_id AND t.transport_order_no = v_no AND t.id <> v_tx.id AND t.cancelled_at IS NULL;
  IF v_other.id IS NOT NULL THEN
    PERFORM app.fail('MRS_TASTO_TAKEN', CASE WHEN app.has_tx_role(v_other.id, app.staff_roles()) THEN v_other.ref ELSE 'other' END);
  END IF;
  v_same := coalesce(v_tx.transport_mode = 'carrier_order' AND v_tx.transport_order_no = v_no AND v_tx.transport_order_date = v_date
            AND v_tx.transport_party_id = v_party, false);
  IF NOT v_same THEN
    UPDATE public.transactions t SET transport_mode = 'carrier_order', transport_party_id = v_party, transport_order_no = v_no,
           transport_order_date = v_date
     WHERE t.id = v_tx.id;
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
    VALUES (v_tx.org_id, v_tx.id, 'note',
            CASE WHEN v_tx.transport_order_no IS NOT NULL THEN 'تعديل أمر نقل شركة: ' ELSE 'تسجيل أمر نقل شركة: ' END
              || v_name || ' — ' || v_no || ' — ' || to_char(v_date, 'YYYY-MM-DD'),
            false, auth.uid(),
            jsonb_build_object('op', 'carrier_order', 'order_no', v_no, 'order_date', v_date, 'party_id', v_party,
                               'previous_order_no', v_tx.transport_order_no, 'bypasses_empty_return', false));
  END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = v_tx.id;
  v_res := jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'operational_status', v_tx.operational_status,
    'transport_mode', v_tx.transport_mode, 'order_no', v_tx.transport_order_no, 'order_date', v_tx.transport_order_date,
    'party_id', v_tx.transport_party_id, 'party_name', v_name, 'party_created', v_created, 'already_exists', v_same,
    'readiness', app.tx_readiness_of(v_tx));
  RETURN app.idem_finish('save_transport_carrier_order', v_key, v_res);
END $$;

-- tx_readiness(p_tx) — the readiness banner (legacy getTransactionEmptyReturnReadiness_ / renderEmptyReturnFollowUpWarning):
-- {transaction_id, ref, operational_status, cargo_unit_type, policy {empty_return_blocks_billing: true, switchable: false},
--  containers_total, pending_count, declared_missing, pending_containers [{container_id, container_no, return_status,
--  return_deadline, overdue, proofs_pending}], billing_gate_open, blocking 'containers_not_returned' | null, proofs
--  {pending_review, unreadable, approved}, movements, carrier_order {order_no, order_date, party_id, party_name,
--  bypasses_empty_return: false} | null}. The gate itself stays in set_transaction_status. Staff of the branch.
CREATE OR REPLACE FUNCTION public.tx_readiness(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  RETURN app.tx_readiness_of(v_tx);
END $$;

-- ---------------------------------------------------------------------
-- 6. conversion lists (20261120000100 §6, re-created): + the 3 tables of this file (test rows, deleted) and their
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
    'public.appointment_drafts', 'public.appointment_draft_cards', 'public.empty_return_proofs',                -- APPT
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
    'public.appointment_drafts:trg_no_delete', 'public.appointment_draft_cards:trg_no_delete',             -- APPT
    'public.empty_return_proofs:trg_no_delete'                                                             -- APPT
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 7. RLS, policies, grants, function privileges
-- ---------------------------------------------------------------------
ALTER TABLE public.appointment_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_draft_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.empty_return_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.appointment_drafts, public.appointment_draft_cards, public.empty_return_proofs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.appointment_drafts, public.empty_return_proofs TO authenticated;
-- cards: the review may carry the trip cost / sell (trip-finance roles only): outside the column grant (fail closed; the
-- review comes through get_appointment_draft, which strips the amounts for the other roles)
DO $colg$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'appointment_draft_cards' AND c.column_name <> 'review';
  REVOKE SELECT ON public.appointment_draft_cards FROM authenticated;
  EXECUTE format('GRANT SELECT (%s) ON public.appointment_draft_cards TO authenticated', v_cols);
END $colg$;
-- transport_trips (20261118000100 §7, re-run): the new party columns join the column grant (cost / sell stay outside)
DO $cols$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'transport_trips'
     AND NOT (c.column_name = ANY (ARRAY['cost_amount','cost_currency','sell_amount','sell_currency','cost_basis']));
  EXECUTE format('GRANT SELECT (%s) ON public.transport_trips TO authenticated', v_cols);
END $cols$;
DROP POLICY IF EXISTS appointment_drafts_select ON public.appointment_drafts;
CREATE POLICY appointment_drafts_select ON public.appointment_drafts FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));
DROP POLICY IF EXISTS appointment_draft_cards_select ON public.appointment_draft_cards;
CREATE POLICY appointment_draft_cards_select ON public.appointment_draft_cards FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.appointment_drafts d WHERE d.id = batch_id AND app.has_tx_role(d.transaction_id, app.staff_roles())));
DROP POLICY IF EXISTS empty_return_proofs_select ON public.empty_return_proofs;
CREATE POLICY empty_return_proofs_select ON public.empty_return_proofs FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.staff_roles()));

-- the field / detail validators stay executable for the CHECK constraints (as in 20261119000100 §7)
REVOKE EXECUTE ON FUNCTION app.extraction_appt_section_ok(jsonb), app.extraction_appt_detail_ok(jsonb), app.extraction_eir_detail_ok(jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.extraction_appt_section_ok(jsonb), app.extraction_appt_detail_ok(jsonb), app.extraction_eir_detail_ok(jsonb)
TO authenticated;
-- the policy flag: signed-in users and the Edge Functions, never anon
REVOKE EXECUTE ON FUNCTION app.empty_return_blocks_billing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.empty_return_blocks_billing(uuid) TO authenticated, service_role;
-- internal helpers and trigger functions: SECURITY DEFINER code / triggers only
REVOKE EXECUTE ON FUNCTION app.appt_ts(jsonb, text), app.appt_review_check(jsonb), app.appt_card_val(public.appointment_draft_cards, text),
  app.appointment_fingerprint_state(uuid, text), app.appt_card_json(public.appointment_draft_cards, boolean),
  app.appt_draft_json(public.appointment_drafts), app.appt_draft_lock(uuid),
  app.appt_card_approve(public.transactions, public.appointment_draft_cards), app.erp_json(public.empty_return_proofs),
  app.tx_readiness_of(public.transactions), app.tg_appointments_card_link(), app.tg_transactions_appt_drafts(),
  app.tg_legacy_appt_guard()
FROM PUBLIC, anon, authenticated, service_role;
-- the conversion lists stay SQL Editor only (20261115000100 §4)
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_delete_guards() FROM PUBLIC, anon, authenticated, service_role;
-- staff RPCs: authenticated only
REVOKE ALL ON FUNCTION public.appointment_card_state(uuid, uuid, text[]), public.save_appointment_draft(uuid, jsonb),
  public.get_appointment_draft(uuid, uuid), public.cancel_appointment_draft(uuid, text), public.move_appointment_draft(uuid, text, text),
  public.approve_appointment_draft(uuid, jsonb), public.create_empty_return_proof(uuid, jsonb), public.verify_empty_return_proof(uuid, jsonb),
  public.void_empty_return_proof(uuid, text), public.save_empty_return_deadline(uuid, date), public.list_empty_return_proofs(uuid),
  public.save_transport_carrier_order(uuid, jsonb), public.tx_readiness(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.appointment_card_state(uuid, uuid, text[]), public.save_appointment_draft(uuid, jsonb),
  public.get_appointment_draft(uuid, uuid), public.cancel_appointment_draft(uuid, text), public.move_appointment_draft(uuid, text, text),
  public.approve_appointment_draft(uuid, jsonb), public.create_empty_return_proof(uuid, jsonb), public.verify_empty_return_proof(uuid, jsonb),
  public.void_empty_return_proof(uuid, text), public.save_empty_return_deadline(uuid, date), public.list_empty_return_proofs(uuid),
  public.save_transport_carrier_order(uuid, jsonb), public.tx_readiness(uuid)
TO authenticated;
-- re-created functions (extraction_field_keys, extraction_detail_ok, movement_json, convert_delete_tables, convert_delete_guards):
-- CREATE OR REPLACE keeps their existing privileges; restated above
