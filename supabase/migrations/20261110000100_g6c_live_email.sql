-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261110000100 — G6c: LIVE e-mail channel (IMAP 993 + SMTP 465, one allowlisted
-- mailbox) next to the G6b mock (docs/online/G6C_LIVE_EMAIL.md). Builds on MFA (20261109000100).
--
-- NO credential in the database: the mailbox login lives in Edge Function secrets only (index.ts, owner-entered);
-- the Edge Function builds the live adapter only for the ONE channel id in MARSA_EMAIL_LIVE_CHANNEL whose address_norm
-- equals MARSA_EMAIL_FROM_ADDRESS. 'live_pending' is unchanged (claim → failed not_configured).
--   P. preflight (MFA applied) + schema_versions row
--   0. dictionary   msg_channel_mode 'live'
--   1. constraints  msg_channels mode IN (mock, live_pending, live); 'live' only for kind 'email'
--   2. helper       app.msg_live_message_id (the one bracketed Message-ID format, review H2)
--   3. re-created   (bodies copied from 20261107000100, changed minimally; no other migration re-creates them)
--                   app.msg_ingest_one      + live: verified → known when dmarc <> 'pass' (signal dmarc_not_pass);
--                                             + live: an In-Reply-To / References match joins the thread only for a sender
--                                               that thread knows, else a new thread + signal thread_ref_foreign_sender
--                                               + flag sender_unverified (security review M7)
--                   app.msg_outbound_accepted + live: stored outbound headers.message_id = bracketed provider_message_id (H2)
--                   public.save_msg_channel + 'live' accepted for e-mail only (same admin gate; the switch resets to
--                                             not_connected as before)
--                   app.msg_complete        + live poll: one message the SQL rules refuse is skipped, recorded (result
--                                             items + an 'ingest_skip' call) and the cursor still advances (review C1)
--                                             + live probe: effects.mailbox.cursor seeds an empty (or non-v1) poll_cursor /
--                                               status_cursor (correctness review M7); the key is removed before
--                                               msg_apply_probe (unchanged)
--                   app.msg_apply_delivery  + a status-poll DSN on a live channel never settles an 'unknown' outbound
--                                             (event recorded, state left for a human; security review H4 d)
--                   public.msg_schedule     + live channels polled at > 100 s (review M8), status jobs as mock
--   4. privileges   (re-asserted identically for the re-created functions)
-- Unchanged on purpose: msg_claim_jobs (refuses live_pending only), msg_ingest_messages / msg_record_delivery / mock
-- load-save (mock only). Every mock / live_pending path behaves exactly as before.
-- Adds no table and no column. Re-runnable (CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS / ON CONFLICT).
-- Re-pasting 20261107000100 after this file restores the G6b bodies (live refused by save_msg_channel, not scheduled):
-- re-paste this file right after.
-- Down-path: set every live channel back to mode 'mock' (or 'live_pending'), then re-paste the G6b bodies.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261109000100') THEN
    RAISE EXCEPTION 'G6c preflight: apply MFA first (schema_versions lacks 20261109000100 mfa)';
  END IF;
  IF to_regclass('public.msg_channels') IS NULL THEN
    RAISE EXCEPTION 'G6c preflight: public.msg_channels not found (G6b inbox schema missing)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261110000100', 'g6c_live_email')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionary (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('msg_channel_mode','live',3,'حساب بريد حقيقي — متصل (IMAP / SMTP)','Live e-mail account (IMAP / SMTP)',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. constraints
-- ---------------------------------------------------------------------
ALTER TABLE public.msg_channels DROP CONSTRAINT IF EXISTS msg_channels_mode_check;
ALTER TABLE public.msg_channels ADD CONSTRAINT msg_channels_mode_check CHECK (mode IN ('mock','live_pending','live'));
ALTER TABLE public.msg_channels DROP CONSTRAINT IF EXISTS msg_channels_live_kind_chk;
ALTER TABLE public.msg_channels ADD CONSTRAINT msg_channels_live_kind_chk CHECK (mode <> 'live' OR kind = 'email');

-- ---------------------------------------------------------------------
-- 2. helper
-- ---------------------------------------------------------------------
-- the stored form of a live outbound Message-ID: '<MRSO-…@domain>' (brackets added once); anything else → NULL
CREATE OR REPLACE FUNCTION app.msg_live_message_id(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN btrim(coalesce(p, ''), '<> ') ~ '^MRSO-[0-9A-F]{16}@[A-Za-z0-9.-]{1,200}$'
              THEN '<' || btrim(p, '<> ') || '>' END
$$;

-- ---------------------------------------------------------------------
-- 3. re-created functions (20261107000100 bodies, minimal G6c changes marked "G6c")
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.msg_ingest_one(p_ch public.msg_channels, p_m jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_pmid text; v_dup public.msg_messages; v_from jsonb; v_from_norm text; v_from_name text; v_to jsonb; v_cc jsonb; v_rcpt text;
        v_sent timestamptz; v_at timestamptz; v_subject text; v_body text; v_headers jsonb; v_wa jsonb; v_auth jsonb; v_raw jsonb;
        v_ptid text; v_thread public.msg_threads; v_msg public.msg_messages; v_flags text[] := '{}'; v_status text := 'unknown';
        v_addr public.msg_contact_addresses; v_signals jsonb := '{}'::jsonb; v_ids text[]; e jsonb; k text; v_dom text;
        v_att_id uuid; v_new_thread boolean := false; v_n int := 0; v_txt text;
BEGIN
  IF p_m IS NULL OR jsonb_typeof(p_m) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'message'); END IF;
  PERFORM app.only_keys(p_m, ARRAY['provider_message_id','provider_thread_id','kind','from','to','cc','sent_at','subject','body_text',
                                   'headers','wa_context','auth','attachments','raw']);
  v_pmid := app.msg_rtext(p_m, 'provider_message_id', 200);
  IF v_pmid IS NULL OR btrim(v_pmid) = '' OR v_pmid ~ '[[:cntrl:]]' THEN PERFORM app.fail('MRS_INVALID', 'provider_message_id'); END IF;
  IF coalesce(app.msg_rtext(p_m, 'kind', 20), p_ch.kind) <> p_ch.kind THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  -- dedupe (webhook + poll, re-delivery, retry): the existing copy, nothing changes
  SELECT * INTO v_dup FROM public.msg_messages m
   WHERE m.org_id = p_ch.org_id AND m.channel_id = p_ch.id AND m.provider_message_id = v_pmid;
  IF v_dup.id IS NOT NULL THEN
    RETURN jsonb_build_object('provider_message_id', v_pmid, 'message_id', v_dup.id, 'thread_id', v_dup.thread_id, 'duplicate', true);
  END IF;
  v_from := p_m -> 'from';
  IF v_from IS NULL OR jsonb_typeof(v_from) <> 'object' OR jsonb_typeof(v_from -> 'address') <> 'string'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_from) x WHERE x NOT IN ('address','name')) THEN
    PERFORM app.fail('MRS_INVALID', 'from');
  END IF;
  v_from_norm := app.msg_try_norm(p_ch.kind, v_from ->> 'address');
  IF v_from_norm IS NULL THEN PERFORM app.fail('MRS_INVALID', 'from'); END IF;
  v_from_name := nullif(btrim(coalesce(app.msg_rtext(v_from, 'name', 160, 'from'), '')), '');
  v_to := app.msg_parse_addrs(p_ch.kind, p_m -> 'to', 'to');
  v_cc := app.msg_parse_addrs(p_ch.kind, p_m -> 'cc', 'cc');
  v_sent := app.msg_rts(p_m, 'sent_at');
  v_at := least(coalesce(v_sent, clock_timestamp()), clock_timestamp());
  v_subject := app.msg_rtext(p_m, 'subject', 500);
  IF jsonb_typeof(p_m -> 'body_text') IS DISTINCT FROM 'string' THEN PERFORM app.fail('MRS_INVALID', 'body_text'); END IF;
  v_body := p_m ->> 'body_text';
  IF char_length(v_body) > 100000 THEN PERFORM app.fail('MRS_INVALID', 'body_text'); END IF;
  v_ptid := app.msg_rtext(p_m, 'provider_thread_id', 200);
  -- headers (e-mail only)
  IF jsonb_typeof(p_m -> 'headers') = 'object' THEN
    IF p_ch.kind <> 'email' THEN PERFORM app.fail('MRS_INVALID', 'headers'); END IF;
    PERFORM app.only_keys(p_m -> 'headers', ARRAY['message_id','in_reply_to','references']);
    IF jsonb_typeof(coalesce(p_m #> '{headers,references}', '[]'::jsonb)) NOT IN ('array','null')
       OR jsonb_array_length(coalesce(nullif(p_m #> '{headers,references}', 'null'::jsonb), '[]'::jsonb)) > 50
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p_m #> '{headers,references}', 'null'::jsonb), '[]'::jsonb)) x
                   WHERE jsonb_typeof(x) <> 'string' OR char_length(x #>> '{}') > 998) THEN
      PERFORM app.fail('MRS_INVALID', 'headers');
    END IF;
    v_headers := jsonb_build_object('message_id', app.msg_rtext(p_m -> 'headers', 'message_id', 998, 'headers'),
                                    'in_reply_to', app.msg_rtext(p_m -> 'headers', 'in_reply_to', 998, 'headers'),
                                    'references', coalesce(nullif(p_m #> '{headers,references}', 'null'::jsonb), '[]'::jsonb));
  ELSIF jsonb_typeof(p_m -> 'headers') IS NOT NULL AND jsonb_typeof(p_m -> 'headers') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'headers');
  END IF;
  IF jsonb_typeof(p_m -> 'wa_context') = 'object' THEN
    IF p_ch.kind <> 'whatsapp' THEN PERFORM app.fail('MRS_INVALID', 'wa_context'); END IF;
    PERFORM app.only_keys(p_m -> 'wa_context', ARRAY['reply_to_provider_id','type']);
    v_wa := jsonb_build_object('reply_to_provider_id', app.msg_rtext(p_m -> 'wa_context', 'reply_to_provider_id', 200, 'wa_context'),
                               'type', app.msg_rtext(p_m -> 'wa_context', 'type', 40, 'wa_context'));
  ELSIF jsonb_typeof(p_m -> 'wa_context') IS NOT NULL AND jsonb_typeof(p_m -> 'wa_context') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'wa_context');
  END IF;
  IF jsonb_typeof(p_m -> 'auth') = 'object' THEN
    IF p_ch.kind <> 'email' THEN PERFORM app.fail('MRS_INVALID', 'auth'); END IF;
    PERFORM app.only_keys(p_m -> 'auth', ARRAY['spf','dkim','dmarc']);
    FOREACH k IN ARRAY ARRAY['spf','dkim','dmarc'] LOOP
      IF coalesce(p_m -> 'auth' ->> k, 'none') NOT IN ('pass','fail','none') THEN PERFORM app.fail('MRS_INVALID', 'auth'); END IF;
    END LOOP;
    v_auth := jsonb_build_object('spf', coalesce(p_m #>> '{auth,spf}', 'none'), 'dkim', coalesce(p_m #>> '{auth,dkim}', 'none'),
                                 'dmarc', coalesce(p_m #>> '{auth,dmarc}', 'none'));
  ELSIF jsonb_typeof(p_m -> 'auth') IS NOT NULL AND jsonb_typeof(p_m -> 'auth') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'auth');
  END IF;
  IF jsonb_typeof(coalesce(p_m -> 'attachments', '[]'::jsonb)) NOT IN ('array','null')
     OR jsonb_array_length(coalesce(nullif(p_m -> 'attachments', 'null'::jsonb), '[]'::jsonb)) > 20 THEN
    PERFORM app.fail('MRS_INVALID', 'attachments');
  END IF;
  v_raw := app.msg_redact(coalesce(p_m -> 'raw', '{}'::jsonb));
  IF octet_length(v_raw::text) > 262144 THEN v_raw := jsonb_build_object('truncated', true); END IF;
  -- the receiving entity: the channel address among to / cc (WhatsApp: the number itself)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_to || v_cc) x WHERE x ->> 'address' = p_ch.address_norm)
     OR (p_ch.kind = 'whatsapp' AND jsonb_array_length(v_to) = 0) THEN
    v_rcpt := p_ch.address_norm;
  ELSE
    v_flags := v_flags || 'not_addressed_to_channel'::text;
  END IF;
  -- §10 sender check
  SELECT * INTO v_addr FROM public.msg_contact_addresses a
   WHERE a.org_id = p_ch.org_id AND a.kind = p_ch.kind AND a.address_norm = v_from_norm AND a.status = 'active';
  v_status := CASE WHEN v_addr.id IS NULL THEN 'unknown' WHEN v_addr.verified_at IS NULL THEN 'known' ELSE 'verified' END;
  IF v_auth IS NOT NULL AND (v_auth ->> 'spf' = 'fail' OR v_auth ->> 'dkim' = 'fail' OR v_auth ->> 'dmarc' = 'fail') THEN
    v_signals := v_signals || jsonb_build_object('auth_fail', true);
    IF v_status = 'verified' THEN v_status := 'mismatch'; END IF;
  END IF;
  -- G6c (design § 4): on a LIVE mailbox a verified contact stays verified only with DMARC pass (spoofed From with 'none')
  IF p_ch.mode = 'live' AND v_status = 'verified' AND coalesce(v_auth ->> 'dmarc', 'none') <> 'pass' THEN
    v_signals := v_signals || jsonb_build_object('dmarc_not_pass', true);
    v_status := 'known';
  END IF;
  IF v_from_name IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.msg_contacts c
        WHERE c.org_id = p_ch.org_id AND c.is_active AND lower(btrim(c.display_name)) = lower(v_from_name)
          AND c.id IS DISTINCT FROM v_addr.contact_id
          AND NOT EXISTS (SELECT 1 FROM public.msg_contact_addresses a WHERE a.contact_id = c.id AND a.address_norm = v_from_norm AND a.status = 'active')) THEN
    v_signals := v_signals || jsonb_build_object('display_name_match_other_contact', true);
    v_status := 'mismatch';
  END IF;
  IF p_ch.kind = 'email' THEN
    v_dom := split_part(v_from_norm, '@', 2);
    IF EXISTS (SELECT 1 FROM public.msg_contact_addresses a
                WHERE a.org_id = p_ch.org_id AND a.kind = 'email' AND a.status = 'active' AND a.verified_at IS NOT NULL
                  AND split_part(a.address_norm, '@', 2) <> v_dom
                  AND app.msg_levenshtein(split_part(a.address_norm, '@', 2), v_dom) <= 2) THEN
      v_signals := v_signals || jsonb_build_object('lookalike_domain', true);
      v_status := 'spoof_suspected';
    END IF;
  END IF;
  IF v_status IN ('unknown','known') THEN v_flags := v_flags || 'sender_unverified'::text; END IF;
  -- G6b-6 thread resolution
  IF p_ch.kind = 'email' THEN
    v_ids := ARRAY(SELECT x FROM (SELECT v_headers ->> 'in_reply_to' AS x
                                  UNION SELECT jsonb_array_elements_text(coalesce(v_headers -> 'references', '[]'::jsonb))) y WHERE x IS NOT NULL);
    IF cardinality(v_ids) > 0 THEN
      SELECT t.* INTO v_thread FROM public.msg_messages m JOIN public.msg_threads t ON t.id = m.thread_id
       WHERE m.channel_id = p_ch.id AND ((m.headers ->> 'message_id') = ANY (v_ids) OR m.provider_message_id = ANY (v_ids))
       ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
      -- G6c (security review M7): on a LIVE mailbox a reference joins a thread only for a sender that thread already knows
      -- (its counterpart, or the from / to / cc of one of its messages); anyone else holding a Message-ID opens a new thread
      IF p_ch.mode = 'live' AND v_thread.id IS NOT NULL AND v_from_norm IS DISTINCT FROM v_thread.counterpart_address_norm
         AND NOT EXISTS (SELECT 1 FROM public.msg_messages m
                          WHERE m.thread_id = v_thread.id
                            AND (m.from_address_norm = v_from_norm
                                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(m.to_addresses, '[]'::jsonb) || coalesce(m.cc_addresses, '[]'::jsonb)) x
                                             WHERE lower(x ->> 'address') = v_from_norm))) THEN
        v_signals := v_signals || jsonb_build_object('thread_ref_foreign_sender', true);
        IF NOT ('sender_unverified' = ANY (v_flags)) THEN v_flags := v_flags || 'sender_unverified'::text; END IF;
        v_thread := NULL;
        v_ptid := NULL;
      END IF;
    END IF;
    IF v_thread.id IS NULL AND v_ptid IS NOT NULL THEN
      SELECT t.* INTO v_thread FROM public.msg_threads t WHERE t.channel_id = p_ch.id AND t.provider_thread_id = v_ptid
       ORDER BY t.created_at DESC, t.id DESC LIMIT 1;
    END IF;
  ELSE
    SELECT t.* INTO v_thread FROM public.msg_threads t
     WHERE t.channel_id = p_ch.id AND t.kind = 'whatsapp' AND t.counterpart_address_norm = v_from_norm AND t.status NOT IN ('resolved','spam');
    IF v_thread.id IS NOT NULL AND v_at - coalesce(v_thread.last_message_at, v_thread.created_at) > interval '7 days' THEN
      -- a stale open conversation is closed (audited); the new message opens a new thread
      UPDATE public.msg_threads t SET status = 'resolved' WHERE t.id = v_thread.id;
      v_thread := NULL;
    END IF;
  END IF;
  IF v_thread.id IS NULL THEN
    INSERT INTO public.msg_threads (org_id, channel_id, branch_id, kind, subject, provider_thread_id, counterpart_address_norm, contact_id)
    VALUES (p_ch.org_id, p_ch.id, p_ch.default_branch_id, p_ch.kind, v_subject, v_ptid, v_from_norm, v_addr.contact_id)
    RETURNING * INTO v_thread;
    v_new_thread := true;
  ELSE
    SELECT * INTO v_thread FROM public.msg_threads t WHERE t.id = v_thread.id FOR UPDATE;
  END IF;
  INSERT INTO public.msg_messages (org_id, thread_id, channel_id, direction, provider_message_id, provider_thread_id, from_address,
                                   from_address_norm, from_name, to_addresses, cc_addresses, recipient_address_norm, sent_at, subject,
                                   body_text, body_sha256, headers, wa_context, auth_results, raw, sender_status, sender_contact_id,
                                   sender_address_id, sender_signals, risk_flags, ingest_source)
  VALUES (p_ch.org_id, v_thread.id, p_ch.id, 'inbound', v_pmid, v_ptid, left(v_from ->> 'address', 254), v_from_norm, v_from_name, v_to, v_cc,
          v_rcpt, v_sent, v_subject, v_body, app.msg_text_hash(v_body), jsonb_strip_nulls(v_headers), jsonb_strip_nulls(v_wa), v_auth, v_raw,
          v_status, v_addr.contact_id, v_addr.id, v_signals, v_flags, p_source)
  RETURNING * INTO v_msg;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_m -> 'attachments', 'null'::jsonb), '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'attachments'); END IF;
    PERFORM app.only_keys(e, ARRAY['provider_attachment_id','file_name','mime_type','size_bytes','sha256','extracted_text']);
    IF app.msg_rtext(e, 'provider_attachment_id', 200, 'attachments') IS NULL OR app.msg_rtext(e, 'file_name', 255, 'attachments') IS NULL
       OR btrim(e ->> 'file_name') = '' THEN
      PERFORM app.fail('MRS_INVALID', 'attachments');
    END IF;
    IF e ? 'sha256' AND jsonb_typeof(e -> 'sha256') <> 'null' AND coalesce(e ->> 'sha256', '') !~ '^[0-9a-f]{64}$' THEN
      PERFORM app.fail('MRS_INVALID', 'attachments');
    END IF;
    v_txt := app.msg_rtext(e, 'extracted_text', 100000, 'attachments');
    v_att_id := gen_random_uuid();
    INSERT INTO public.msg_attachments (id, org_id, message_id, thread_id, provider_attachment_id, file_name, mime_type, size_bytes, sha256,
                                        storage_path, extracted_text)
    VALUES (v_att_id, p_ch.org_id, v_msg.id, v_thread.id, e ->> 'provider_attachment_id',
            left(regexp_replace(e ->> 'file_name', '[[:cntrl:]]', '', 'g'), 255),
            app.msg_rtext(e, 'mime_type', 120, 'attachments'),
            coalesce(app.msg_rint(e, 'size_bytes', 0, 26214400, 'attachments'), 0), nullif(e ->> 'sha256', ''),
            p_ch.org_id::text || '/' || p_ch.id::text || '/' || v_msg.id::text || '/' || v_att_id::text || '/' || app.msg_safe_name(e ->> 'file_name'),
            v_txt)
    ON CONFLICT (message_id, provider_attachment_id) DO NOTHING;
  END LOOP;
  UPDATE public.msg_threads t
     SET message_count = t.message_count + 1, unread_count = t.unread_count + 1,
         last_message_at = greatest(coalesce(t.last_message_at, v_at), v_at),
         last_inbound_at = greatest(coalesce(t.last_inbound_at, v_at), v_at),
         risk_flags = ARRAY(SELECT DISTINCT x FROM unnest(t.risk_flags || v_flags) x ORDER BY 1),
         contact_id = coalesce(t.contact_id, v_addr.contact_id),
         status = CASE WHEN t.status IN ('resolved','awaiting_external') THEN 'in_progress' ELSE t.status END
   WHERE t.id = v_thread.id;
  PERFORM app.msg_enqueue(p_ch.org_id, 'process', p_ch.id, v_thread.id, v_msg.id, NULL, NULL, '{}'::jsonb, NULL);
  RETURN jsonb_build_object('provider_message_id', v_pmid, 'message_id', v_msg.id, 'thread_id', v_thread.id, 'duplicate', false,
                            'new_thread', v_new_thread);
END $$;

-- outbound accepted by the provider: reply sent, outbound copy in the thread, thread awaiting the counterpart
CREATE OR REPLACE FUNCTION app.msg_outbound_accepted(p_o public.msg_outbound, p_provider_id text, p_state text, p_at timestamptz) RETURNS public.msg_outbound
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.msg_outbound; t public.msg_threads; r public.msg_replies; v_reply_to public.msg_messages; v_pid text;
BEGIN
  v_pid := coalesce(p_provider_id, p_o.provider_message_id, p_o.provider_request_id);
  UPDATE public.msg_outbound x SET state = p_state, provider_message_id = coalesce(x.provider_message_id, v_pid),
         accepted_at = coalesce(x.accepted_at, p_at), delivered_at = CASE WHEN p_state IN ('delivered','read') THEN coalesce(x.delivered_at, p_at) ELSE x.delivered_at END,
         read_at = CASE WHEN p_state = 'read' THEN coalesce(x.read_at, p_at) ELSE x.read_at END, last_error_code = NULL, last_error_message = NULL
   WHERE x.id = p_o.id RETURNING * INTO o;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = o.reply_id;
  UPDATE public.msg_replies x SET status = 'sent' WHERE x.id = o.reply_id AND x.status <> 'sent';
  IF NOT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.outbound_id = o.id) THEN
    SELECT * INTO v_reply_to FROM public.msg_messages m WHERE m.id = r.reply_to_message_id;
    INSERT INTO public.msg_messages (org_id, thread_id, channel_id, direction, provider_message_id, from_address, from_address_norm, to_addresses,
                                     cc_addresses, recipient_address_norm, sent_at, subject, body_text, body_sha256, headers, sender_status,
                                     outbound_id, ingest_source)
    VALUES (o.org_id, o.thread_id, o.channel_id, 'outbound', o.provider_message_id, o.from_address_norm, o.from_address_norm,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('address', x ->> 'address_norm', 'name', NULL)), '[]'::jsonb) FROM jsonb_array_elements(o.to_addresses) x),
            (SELECT coalesce(jsonb_agg(jsonb_build_object('address', x ->> 'address_norm', 'name', NULL)), '[]'::jsonb) FROM jsonb_array_elements(o.cc_addresses) x),
            NULL, p_at, o.subject, o.body_text, app.msg_text_hash(o.body_text),
            CASE WHEN EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.id = o.channel_id AND c.kind = 'email')
                 THEN jsonb_strip_nulls(jsonb_build_object('message_id',
                        -- G6c (review H2): a live outbound keeps the Message-ID it was really sent with
                        CASE WHEN EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.id = o.channel_id AND c.mode = 'live')
                                  AND app.msg_live_message_id(o.provider_message_id) IS NOT NULL
                             THEN app.msg_live_message_id(o.provider_message_id)
                             ELSE '<' || o.provider_request_id || '@marsa.invalid>' END,
                                                           'in_reply_to', v_reply_to.headers ->> 'message_id')) END,
            'verified', o.id, 'send')
    ON CONFLICT (org_id, channel_id, provider_message_id) DO NOTHING;
    UPDATE public.msg_threads x SET message_count = x.message_count + 1, last_outbound_at = p_at,
           last_message_at = greatest(coalesce(x.last_message_at, p_at), p_at),
           status = CASE WHEN x.status = 'spam' THEN x.status ELSE 'awaiting_external' END
     WHERE x.id = o.thread_id RETURNING * INTO t;
    SELECT * INTO t FROM public.msg_threads x WHERE x.id = o.thread_id;
    PERFORM app.msg_event(o.org_id, t.transaction_id, 'reply_sent', 'outbound', o.id, jsonb_build_object('thread_id', o.thread_id, 'reply_id', o.reply_id));
  END IF;
  RETURN o;
END $$;

CREATE OR REPLACE FUNCTION app.msg_apply_delivery(p_ch public.msg_channels, p_events jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; o public.msg_outbound; v_applied int := 0; v_dup int := 0; v_unknown int := 0; v_status text; v_at timestamptz;
        v_id uuid; v_rank int; v_tx uuid;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 200 THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_events) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
    PERFORM app.only_keys(e, ARRAY['provider_event_id','provider_message_id','provider_request_id','status','at','error_code']);
    v_status := app.msg_rtext(e, 'status', 20, 'events');
    IF v_status IS NULL OR v_status NOT IN ('accepted','sent','delivered','read','failed','bounced') THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
    IF app.msg_rtext(e, 'provider_event_id', 200, 'events') IS NULL THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
    v_at := coalesce(app.msg_rts(e, 'at', 'events'), now());
    SELECT * INTO o FROM public.msg_outbound x
     WHERE x.channel_id = p_ch.id
       AND ((e ? 'provider_request_id' AND x.provider_request_id = e ->> 'provider_request_id')
            OR (e ? 'provider_message_id' AND x.provider_message_id = e ->> 'provider_message_id'))
     ORDER BY x.created_at DESC LIMIT 1 FOR UPDATE;
    IF o.id IS NULL THEN v_unknown := v_unknown + 1; CONTINUE; END IF;
    INSERT INTO public.msg_delivery_events (org_id, outbound_id, provider_event_id, status, error_code, at, source)
    VALUES (o.org_id, o.id, e ->> 'provider_event_id', v_status, app.msg_rtext(e, 'error_code', 60, 'events'), v_at, p_source)
    ON CONFLICT (outbound_id, provider_event_id) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN v_dup := v_dup + 1; CONTINUE; END IF;
    v_applied := v_applied + 1;
    SELECT t.transaction_id INTO v_tx FROM public.msg_threads t WHERE t.id = o.thread_id;
    v_rank := CASE o.state WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'unknown' THEN 1 WHEN 'accepted' THEN 2 WHEN 'delivered' THEN 3
                           WHEN 'read' THEN 4 ELSE 9 END;
    IF v_status IN ('accepted','sent') AND o.state IN ('sending','unknown') THEN
      PERFORM app.msg_outbound_accepted(o, e ->> 'provider_message_id', 'accepted', v_at);
    ELSIF v_status = 'delivered' AND v_rank < 3 AND o.state IN ('sending','unknown','accepted') THEN
      IF o.state IN ('sending','unknown') THEN
        PERFORM app.msg_outbound_accepted(o, e ->> 'provider_message_id', 'delivered', v_at);
      ELSE
        UPDATE public.msg_outbound x SET state = 'delivered', delivered_at = v_at WHERE x.id = o.id;
      END IF;
      PERFORM app.msg_event(o.org_id, v_tx, 'reply_delivered', 'outbound', o.id, jsonb_build_object('thread_id', o.thread_id, 'reply_id', o.reply_id));
    ELSIF v_status = 'read' AND v_rank < 4 AND o.state IN ('accepted','delivered') THEN
      UPDATE public.msg_outbound x SET state = 'read', read_at = v_at, delivered_at = coalesce(x.delivered_at, v_at) WHERE x.id = o.id;
    ELSIF v_status IN ('failed','bounced') AND o.state IN ('sending','accepted','unknown')
          -- G6c (security review H4 d): a DSN read from a LIVE mailbox never settles an 'unknown' send (anyone can mail a
          -- report): the event is recorded above, the state stays for a human (resolve_msg_send_unknown)
          AND NOT (p_ch.mode = 'live' AND p_source = 'status_poll' AND o.state = 'unknown') THEN
      PERFORM app.msg_outbound_failed(o, coalesce(app.msg_rtext(e, 'error_code', 60, 'events'), v_status), 'provider reported ' || v_status);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('applied', v_applied, 'duplicates', v_dup, 'unknown_refs', v_unknown);
END $$;

-- save_msg_channel(p_org, {id?, kind, name, address, default_branch_id, mode, ingest_enabled, send_enabled, provider_terms_ack}, p_idem_key)
CREATE OR REPLACE FUNCTION public.save_msg_channel(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb; v_id uuid; v_old public.msg_channels; v public.msg_channels; v_kind text; v_addr text; v_norm text; v_br uuid;
        v_mode text; v_ing boolean; v_snd boolean; v_ack boolean; v_flags_changed boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  PERFORM app.only_keys(p_payload, ARRAY['id','kind','name','address','default_branch_id','mode','ingest_enabled','send_enabled','provider_terms_ack']);
  v_replay := app.idem_begin('save_msg_channel', p_idem_key, jsonb_build_object('org', p_org, 'p', p_payload), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_id := app.puuid(p_payload, 'id');
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.msg_channels c WHERE c.id = v_id AND c.org_id = p_org FOR UPDATE;
    IF v_old.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
    v := v_old;
  END IF;
  v_kind := coalesce(app.ptext(p_payload, 'kind', 20), v_old.kind);
  IF v_kind IS NULL OR v_kind NOT IN ('email','whatsapp') OR (v_old.id IS NOT NULL AND v_kind <> v_old.kind) THEN
    PERFORM app.fail('MRS_INVALID', 'channel_kind');
  END IF;
  v.kind := v_kind;
  IF p_payload ? 'name' OR v_old.id IS NULL THEN
    v.name := app.ptext(p_payload, 'name', 120, true);
    IF char_length(v.name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name'); END IF;
  END IF;
  IF p_payload ? 'address' OR v_old.id IS NULL THEN
    v_addr := app.ptext(p_payload, 'address', 254, true);
    v_norm := app.msg_norm_address(v_kind, v_addr);
    -- G6b-2: one provider account = one org (the other org is never named)
    IF EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.kind = v_kind AND c.address_norm = v_norm AND c.id IS DISTINCT FROM v_old.id) THEN
      PERFORM app.fail('MRS_INVALID', 'address_taken');
    END IF;
    v.address := v_addr; v.address_norm := v_norm;
  END IF;
  IF p_payload ? 'default_branch_id' THEN
    v_br := app.puuid(p_payload, 'default_branch_id');
    IF v_br IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_br AND b.org_id = p_org) THEN
      PERFORM app.fail('MRS_INVALID', 'branch_id');
    END IF;
    v.default_branch_id := v_br;
  END IF;
  IF p_payload ? 'mode' THEN
    v_mode := app.ptext(p_payload, 'mode', 20, true);
    IF v_mode NOT IN ('mock','live_pending','live') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
    -- G6c: 'live' is the IMAP / SMTP e-mail adapter only (WhatsApp stays mock | live_pending)
    IF v_mode = 'live' AND v_kind <> 'email' THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
    v.mode := v_mode;
  END IF;
  v.mode := coalesce(v.mode, 'mock');
  v_ing := coalesce(app.msg_rbool(p_payload, 'ingest_enabled'), v_old.ingest_enabled, false);
  v_snd := coalesce(app.msg_rbool(p_payload, 'send_enabled'), v_old.send_enabled, false);
  v_ack := coalesce(app.msg_rbool(p_payload, 'provider_terms_ack'), false);
  IF v_ack AND v.provider_terms_ack_at IS NULL THEN v.provider_terms_ack_at := now(); v.provider_terms_ack_by := auth.uid(); END IF;
  IF (v_ing OR v_snd) AND v.provider_terms_ack_at IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'provider_terms'); END IF;
  v_flags_changed := v_ing IS DISTINCT FROM coalesce(v_old.ingest_enabled, false) OR v_snd IS DISTINCT FROM coalesce(v_old.send_enabled, false);
  v.ingest_enabled := v_ing; v.send_enabled := v_snd;
  IF v_old.id IS NULL THEN
    v.status := 'not_connected';
    INSERT INTO public.msg_channels (org_id, kind, name, address, address_norm, default_branch_id, mode, status, ingest_enabled, send_enabled,
                                     provider_terms_ack_by, provider_terms_ack_at, created_by, updated_by)
    VALUES (p_org, v.kind, v.name, v.address, v.address_norm, v.default_branch_id, v.mode, v.status, v.ingest_enabled, v.send_enabled,
            v.provider_terms_ack_by, v.provider_terms_ack_at, auth.uid(), auth.uid())
    RETURNING * INTO v;
  ELSE
    IF v.mode IS DISTINCT FROM v_old.mode OR v.address_norm IS DISTINCT FROM v_old.address_norm THEN
      v.status := 'not_connected'; v.capabilities := '{}'::jsonb; v.capabilities_checked_at := NULL; v.capabilities_source := NULL;
    ELSIF v_flags_changed THEN
      IF NOT v_ing AND NOT v_snd THEN v.status := 'disabled';
      ELSIF v_old.status = 'disabled' THEN
        v.status := CASE WHEN v_old.capabilities_checked_at IS NOT NULL AND v_old.last_error_code IS NULL THEN 'connected' ELSE 'not_connected' END;
      END IF;
    END IF;
    UPDATE public.msg_channels c SET name = v.name, address = v.address, address_norm = v.address_norm, default_branch_id = v.default_branch_id,
           mode = v.mode, status = v.status, ingest_enabled = v.ingest_enabled, send_enabled = v.send_enabled, capabilities = v.capabilities,
           capabilities_checked_at = v.capabilities_checked_at, capabilities_source = v.capabilities_source,
           provider_terms_ack_by = v.provider_terms_ack_by, provider_terms_ack_at = v.provider_terms_ack_at, updated_by = auth.uid()
     WHERE c.id = v_old.id RETURNING * INTO v;
  END IF;
  RETURN app.idem_finish('save_msg_channel', p_idem_key, app.msg_channel_json(v, true) || jsonb_build_object('from', v_old.status));
END $$;

CREATE OR REPLACE FUNCTION app.msg_complete(j public.msg_jobs, a public.msg_job_attempts, p_result jsonb, p_calls jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_outcome text; v_eff jsonb; v_err jsonb; v_status text; v_final boolean; c public.msg_channels; e jsonb; v_n int := 0; v_items jsonb := '[]'::jsonb;
        v_acct text; v_res jsonb; v_calls jsonb := p_calls; v_skipped jsonb := '[]'::jsonb; v_msg text; v_det text; v_state text;
        v_seed text;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'result'); END IF;
  PERFORM app.only_keys(p_result, ARRAY['outcome','error','calls','effects']);
  v_outcome := app.msg_rtext(p_result, 'outcome', 20);
  IF v_outcome IS NULL OR v_outcome NOT IN ('ok','retry','failed','unknown','conflict') THEN PERFORM app.fail('MRS_INVALID', 'outcome'); END IF;
  v_eff := coalesce(nullif(p_result -> 'effects', 'null'::jsonb), '{}'::jsonb);
  IF jsonb_typeof(v_eff) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'effects'); END IF;
  -- G6c (correctness review M7): the live probe's INBOX position (msg_apply_probe itself is unchanged and never sees it)
  IF j.kind = 'probe' THEN
    v_seed := v_eff #>> '{mailbox,cursor}';
    IF v_seed !~ '^v1:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,6}$' THEN v_seed := NULL; END IF;
    v_eff := v_eff - 'mailbox';
  END IF;
  v_err := app.msg_error(p_result -> 'error');
  -- review fix (G6b-15): a send call the worker recorded as applied (or unknown) is never a 'not applied' failure / retry
  IF j.kind = 'send' AND v_outcome IN ('retry','failed')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) x
                  WHERE x ->> 'op' = 'send' AND coalesce(x ->> 'applied', 'unknown') IN ('yes','unknown')) THEN
    v_outcome := 'unknown';
    v_err := coalesce(v_err, '{}'::jsonb) || jsonb_build_object('applied', 'unknown');
    v_eff := v_eff - 'applied';
  END IF;
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = j.channel_id;
  -- a probe of another account than the channel's own: failed, never connected
  IF j.kind = 'probe' AND v_outcome = 'ok' THEN
    v_acct := app.msg_try_norm(c.kind, v_eff #>> '{account,address}');
    IF v_acct IS DISTINCT FROM c.address_norm THEN
      v_outcome := 'failed';
      v_err := jsonb_build_object('kind', 'validation', 'code', 'account_mismatch', 'message', 'the probed account is not the channel address', 'applied', 'no');
    END IF;
  END IF;
  v_status := CASE v_outcome
                WHEN 'ok' THEN 'done' WHEN 'failed' THEN 'failed' WHEN 'conflict' THEN 'conflict'
                WHEN 'retry' THEN CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END
                ELSE CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'unknown' END END;
  v_final := v_status IN ('failed','dead','conflict');
  CASE j.kind
    WHEN 'probe' THEN
      PERFORM app.msg_apply_probe(j, v_outcome = 'ok', v_eff, v_err, v_final);
      -- G6c: mail and bounces after the connect are never passed by a first-run cursor; an existing v1 cursor is kept
      IF v_outcome = 'ok' AND c.mode = 'live' AND v_seed IS NOT NULL THEN
        UPDATE public.msg_channels x
           SET poll_cursor = CASE WHEN coalesce(x.poll_cursor, '') ~ '^v1:' THEN x.poll_cursor ELSE v_seed END,
               status_cursor = CASE WHEN coalesce(x.status_cursor, '') ~ '^v1:' THEN x.status_cursor ELSE v_seed END
         WHERE x.id = c.id;
      END IF;
    WHEN 'poll' THEN
      IF v_outcome = 'ok' THEN
        PERFORM app.only_keys(v_eff, ARRAY['messages','next_cursor']);
        IF jsonb_typeof(coalesce(v_eff -> 'messages', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(v_eff -> 'messages', '[]'::jsonb)) > 50 THEN
          PERFORM app.fail('MRS_INVALID', 'messages');
        END IF;
        FOR e IN SELECT x FROM jsonb_array_elements(coalesce(v_eff -> 'messages', '[]'::jsonb)) x LOOP
          IF c.mode = 'live' THEN
            -- G6c (review C1): one message the SQL rules refuse is skipped and recorded; the batch and the cursor still commit
            BEGIN
              v_res := app.msg_ingest_one(c, e, 'poll');
            EXCEPTION WHEN OTHERS THEN
              GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
              -- only a refusal of the message data is skipped; plan limits, deadlocks and anything else still fail the job
              IF NOT (coalesce(v_msg, '') IN ('MRS_INVALID','MRS_REQUIRED') OR coalesce(v_state, '') LIKE '22%'
                      OR coalesce(v_state, '') IN ('23502','23514')) THEN
                RAISE;
              END IF;
              v_res := jsonb_build_object('provider_message_id', left(regexp_replace(coalesce(e ->> 'provider_message_id', ''), '[[:cntrl:]]', '', 'g'), 200),
                                          'duplicate', false, 'skipped', true,
                                          'code', CASE WHEN v_msg LIKE 'MRS\_%' THEN left(btrim(v_msg || ' ' || coalesce(v_det, '')), 60)
                                                       ELSE 'SQL_' || v_state END);
              v_skipped := v_skipped || jsonb_build_array(v_res);
            END;
          ELSE
            v_res := app.msg_ingest_one(c, e, 'poll');
          END IF;
          v_items := v_items || jsonb_build_array(v_res);
          IF NOT (v_res ->> 'duplicate')::boolean AND NOT coalesce((v_res ->> 'skipped')::boolean, false) THEN v_n := v_n + 1; END IF;
        END LOOP;
        IF jsonb_array_length(v_skipped) > 0 AND jsonb_array_length(coalesce(v_calls, '[]'::jsonb)) < 50 THEN
          v_calls := coalesce(v_calls, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('op', 'ingest_skip', 'at', now(), 'ms', 0,
                       'request', jsonb_build_object('skipped', jsonb_array_length(v_skipped)), 'response', jsonb_build_object('skipped', v_skipped),
                       'error', NULL, 'applied', 'no'));
        END IF;
        UPDATE public.msg_channels x SET poll_cursor = coalesce(app.msg_rtext(v_eff, 'next_cursor', 200), x.poll_cursor), last_poll_at = now() WHERE x.id = c.id;
      END IF;
    WHEN 'process' THEN
      IF v_outcome = 'ok' THEN PERFORM app.msg_apply_process(j, v_eff); END IF;
    WHEN 'draft' THEN
      IF v_outcome = 'ok' THEN PERFORM app.msg_apply_draft(j, v_eff); END IF;
    WHEN 'send' THEN
      PERFORM app.msg_apply_send(j, v_outcome, v_eff, v_err, v_status);
    WHEN 'status' THEN
      IF v_outcome = 'ok' THEN
        PERFORM app.only_keys(v_eff, ARRAY['events','next_cursor']);
        v_res := app.msg_apply_delivery(c, coalesce(v_eff -> 'events', '[]'::jsonb), 'status_poll');
        UPDATE public.msg_channels x SET status_cursor = coalesce(app.msg_rtext(v_eff, 'next_cursor', 200), x.status_cursor) WHERE x.id = c.id;
      END IF;
  END CASE;
  UPDATE public.msg_job_attempts x SET finished_at = clock_timestamp(), outcome = v_outcome, calls = v_calls, error = v_err WHERE x.id = a.id;
  UPDATE public.msg_jobs x SET status = v_status, locked_by = NULL, locked_until = NULL,
         next_run_at = CASE v_status WHEN 'queued' THEN now() + least(interval '30 seconds' * power(2, greatest(j.attempts - 1, 0)), interval '1 hour')
                                     WHEN 'unknown' THEN now() + interval '2 minutes' ELSE x.next_run_at END,
         finished_at = CASE WHEN v_status IN ('done','conflict','failed','dead') THEN now() END,
         last_error_kind = CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(coalesce(v_err ->> 'kind', v_outcome), 60) END,
         last_error_code = CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(v_err ->> 'code', 60) END,
         last_error_message = CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(v_err ->> 'message', 500) END
   WHERE x.id = j.id;
  RETURN jsonb_build_object('job_id', j.id, 'job_status', v_status, 'applied', true, 'outcome', v_outcome)
         || CASE WHEN j.kind = 'poll' THEN jsonb_build_object('ingested', v_n, 'items', v_items) WHEN j.kind = 'status' THEN coalesce(v_res, '{}'::jsonb) ELSE '{}'::jsonb END
         || CASE WHEN j.kind = 'poll' AND c.mode = 'live' THEN jsonb_build_object('skipped', jsonb_array_length(v_skipped)) ELSE '{}'::jsonb END;
END $$;

-- msg_schedule(p_limit) → {enqueued}: poll ingest-enabled connected channels (mock > 1 min, live > 100 s), status for recent accepted outbound
CREATE OR REPLACE FUNCTION public.msg_schedule(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_n int := 0; v_job jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  FOR r IN SELECT c.id, c.org_id, 'poll' AS kind FROM public.msg_channels c
            WHERE c.ingest_enabled AND c.status = 'connected' AND c.mode IN ('mock','live')
              AND (c.last_poll_at IS NULL OR c.last_poll_at < now() - CASE WHEN c.mode = 'live' THEN interval '100 seconds' ELSE interval '1 minute' END)
           UNION ALL
           SELECT c.id, c.org_id, 'status' FROM public.msg_channels c
            WHERE c.status = 'connected' AND c.mode IN ('mock','live')
              AND EXISTS (SELECT 1 FROM public.msg_outbound o WHERE o.channel_id = c.id AND o.state = 'accepted' AND o.accepted_at > now() - interval '7 days')
           ORDER BY 3, 1 LIMIT p_limit LOOP
    v_job := app.msg_enqueue(r.org_id, r.kind, r.id, NULL, NULL, NULL, NULL, '{}'::jsonb, NULL);
    IF NOT (v_job ->> 'deduplicated')::boolean THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('enqueued', v_n);
END $$;

-- ---------------------------------------------------------------------
-- 4. privileges
-- ---------------------------------------------------------------------
-- app.* helpers: revoked from everyone (SECURITY DEFINER callers run them), as every G6b app.msg_* function
REVOKE EXECUTE ON FUNCTION
  app.msg_live_message_id(text), app.msg_ingest_one(public.msg_channels, jsonb, text),
  app.msg_outbound_accepted(public.msg_outbound, text, text, timestamptz),
  app.msg_apply_delivery(public.msg_channels, jsonb, text),
  app.msg_complete(public.msg_jobs, public.msg_job_attempts, jsonb, jsonb)
FROM PUBLIC, anon, authenticated;
-- staff RPC: authenticated; worker RPC: service_role only (as in 20261107000100)
REVOKE ALL ON FUNCTION public.save_msg_channel(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_msg_channel(uuid, jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.msg_schedule(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.msg_schedule(int) TO service_role;
