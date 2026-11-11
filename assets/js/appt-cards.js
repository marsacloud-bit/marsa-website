/* ==========================================================================
   مرسى | MARSA — legacy step 5 UI: appointment cards (TAS) reading + review + approval  →  window.MarsaApptCards
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_APPT_AR.md (20261121000100). ocr.html only (#appt-section), deep link
   ocr.html#appt-tx=<transaction>, for signed-in staff; writes need a transport writer of the transaction's branch.
     * upload up to 20 cards / 25 MB per transaction; before any reading the file fingerprints are checked across the org
       (appointmentCardState): an approved card is blocked, a card pending in another transaction offers to move that draft
       here, a card already in this draft is not read again, a discarded card of this draft is restored without a re-read;
     * the free cards are read by Claude (aiExtract appointment_ticket, ai-doc-v3), 2 at a time (one ai_reserve per call);
       a Fasah / TAS appointment invoice or another document is rejected per card (MRS_AI_WRONG_DOCUMENT <reason>) and is
       not saved; a reading is saved (document_extractions doc_type 'appointment'), the card file is kept as a document
       of the transaction (kind 'appointment'), and the card joins the transaction's open draft (saveAppointmentDraft);
     * the review table: one row per card, inline edits autosaved (450 ms, with the draft version), container picker
       limited to the transaction's containers, transport party per card, movement type (only a full exit becomes a
       movement; an empty entry is skipped);
     * reopening restores the open draft without a re-read (getAppointmentDraft); cancel (with a reason) releases the cards;
       move sends the whole draft to another transaction by its number; approve all / the selected cards behind a confirm
       dialog (version + idempotency key) with a per-card result (saved / already existed / skipped / failed).
   * Every AI value stays a DRAFT until a staff member approves it. Nothing is approved automatically.
   * Strings: namespace 'appt' (assets/i18n/appt.js). Server data only through textContent / createElement. ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  /* ==================================================================
     Pure helpers (no DOM)
     ================================================================== */
  var CARD_MAX = 20;
  var BATCH_BYTES = 26214400;           // 25 MB per batch (server MRS_APPT_DRAFT_LIMIT size)
  var CARD_MAX_BYTES = 10485760;        // a card file (server file_size ≤ 10 MB)
  var IMAGE_MAX_BYTES = 5242880;        // the AI per-image limit (supa.js AI_MAX_IMAGE_BYTES)
  var CONCURRENCY = 2;                  // legacy R1212 analyzeAppointmentTicketsR1212Fast: 2–3 at a time
  var AUTOSAVE_MS = 450;                // legacy r1213BindAppointmentAutosave
  var MOVEMENT_TYPES = ['full_exit', 'empty_entry'];
  var PARTY_TYPES = ['supplier', 'company', 'direct'];
  var CARD_STATUSES = ['pending', 'approved', 'skipped', 'failed', 'discarded', 'cancelled'];
  var BATCH_STATUSES = ['pending', 'partial', 'approved', 'cancelled', 'moved'];
  var OUTCOMES = ['saved', 'already_existed', 'skipped', 'failed'];
  var REJECT_REASONS = ['appointment_invoice', 'not_appointment_ticket', 'not_ticket_structure'];
  // the review keys of save_appointment_draft (app.appt_review_check), cost / sell for trip-finance roles only
  var REVIEW_KEYS = ['container_id', 'container_no', 'appointment_at', 'booking_ref', 'operator_ticket_no', 'operator_name', 'terminal_party_id',
    'zone_gate', 'barcode', 'movement_type', 'driver_name', 'driver_phone', 'truck_plate', 'party_type', 'carrier_id', 'party_name',
    'transport_order_no', 'destination', 'origin', 'notes', 'return_deadline', 'return_location', 'cost_amount', 'sell_amount',
    'gate_instructions', 'driver_license'];
  var MONEY_KEYS = ['cost_amount', 'sell_amount'];
  // the reading keys (ai-extract appointment) a review key falls back to
  var READ_KEYS = ['container_no', 'appointment_at', 'booking_ref', 'operator_ticket_no', 'operator_name', 'zone_gate', 'barcode', 'movement_type',
    'driver_name', 'driver_phone', 'truck_plate', 'gate_instructions', 'driver_license'];
  // the main row and the details row of the review table
  var MAIN_COLS = ['container', 'appointment_at', 'movement_type', 'booking_ref', 'driver_name', 'driver_phone', 'truck_plate', 'party_type', 'party_name'];
  var DETAIL_KEYS = ['operator_ticket_no', 'operator_name', 'zone_gate', 'barcode', 'gate_instructions', 'driver_license', 'transport_order_no',
    'destination', 'origin', 'return_deadline', 'return_location', 'notes'];
  var MISSING = ['movement_type', 'container', 'appointment_at', 'driver_name', 'driver_phone', 'truck_plate', 'party_type', 'party_name'];
  var AI_WARNINGS = ['movement_type_corrected', 'appointment_time_missing', 'datetime_format', 'phone_format', 'container_check_digit', 'wrong_document_type'];
  var AI_MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
  var CTR_RE = /^[A-Z]{4}\d{7}$/;

  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }
  function blank(v) { return v == null || (typeof v === 'string' && !v.replace(/\s+/g, '')); }
  function str(v) { return v == null ? '' : String(v); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  function normContainer(v) { return western(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // 05XXXXXXXX (app.norm_sa_phone: +966 / 00966 / 966 / 5XXXXXXXX)
  function normPhone(v) {
    var d = western(v).replace(/[^\d]/g, '');
    if (/^9665\d{8}$/.test(d)) d = '0' + d.slice(3);
    else if (/^009665\d{8}$/.test(d)) d = '0' + d.slice(5);
    else if (/^5\d{8}$/.test(d)) d = '0' + d;
    return /^05\d{8}$/.test(d) ? d : null;
  }
  function parseHash(h) {
    var s = String(h || '').replace(/^#/, ''), out = {};
    s.split('&').forEach(function (p) {
      var i = p.indexOf('='); if (i < 1) return;
      var k = p.slice(0, i), v = '';
      try { v = decodeURIComponent(p.slice(i + 1)); } catch (e) { return; }
      if (k === 'appt-tx' && isUuid(v)) out.tx = v;
    });
    return out;
  }
  function pageLink(txId) { return 'ocr.html#appt-tx=' + encodeURIComponent(String(txId || '')); }
  function txLink(txId) { return 'admin.html#tx/' + encodeURIComponent(String(txId || '')); }
  // an ISO time (any offset) → 'YYYY-MM-DDTHH:mm' in Riyadh (UTC+3, no daylight saving); a local value stays as it is
  function riyadhLocal(v) {
    var s = western(v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return s.replace(' ', 'T').slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';      // a date without a time: never invent one (MRS_DATETIME_REQUIRED)
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 16);
  }
  // the date-and-time a staff member typed: 'YYYY-MM-DDTHH:mm' (a date alone is refused: MRS_DATETIME_REQUIRED)
  function dateTimeState(v) {
    var s = western(v).trim();
    if (!s) return 'empty';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date_only';
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? 'ok' : 'invalid';
  }
  function mediaType(f) {
    var t = String(f && f.type || '').toLowerCase();
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].indexOf(t) !== -1) return t;
    var n = String(f && f.name || ''), i = n.lastIndexOf('.');
    return i > 0 ? AI_MEDIA[n.slice(i + 1).toLowerCase()] || null : null;
  }
  // 5 MB for an image (the AI limit), 10 MB for a PDF (the AI and the card limit)
  function fileProblem(f) {
    var m = mediaType(f);
    if (!m) return 'unsupported';
    if (Number(f.size) > (m === 'application/pdf' ? CARD_MAX_BYTES : IMAGE_MAX_BYTES)) return 'too_large';
    if (!(Number(f.size) > 0)) return 'empty';
    return null;
  }
  function liveCards(batch) {
    return (batch && Array.isArray(batch.cards) ? batch.cards : []).filter(function (c) { return c && c.status !== 'discarded' && c.status !== 'cancelled'; });
  }
  // the files that fit in the batch (count + size), in order: {accepted [i], rejected [{i, reason too_many|batch_size}]}
  function planFiles(files, batch, inFlight) {
    var live = liveCards(batch), n = live.length + (inFlight ? inFlight.count || 0 : 0);
    var bytes = live.reduce(function (a, c) { return a + (Number(c.file_size) || 0); }, 0) + (inFlight ? inFlight.bytes || 0 : 0);
    var out = { accepted: [], rejected: [] };
    (files || []).forEach(function (f, i) {
      var sz = Number(f && f.size) || 0;
      if (n + 1 > CARD_MAX) { out.rejected.push({ i: i, reason: 'too_many' }); return; }
      if (bytes + sz > BATCH_BYTES) { out.rejected.push({ i: i, reason: 'batch_size' }); return; }
      n++; bytes += sz; out.accepted.push(i);
    });
    return out;
  }
  // what to do with a file, from its fingerprint state (appointment_card_state) and the open draft of this transaction
  //   read | in_batch (already a live card here) | restore (a discarded card of this draft) | approved (blocked) |
  //   move (pending in another transaction, that draft can come here) | pending_other (pending elsewhere, cannot move)
  //   (only a LIVE card of this draft counts: a final one — approved with its appointment cancelled since, skipped,
  //   cancelled — does not stop a new read; the fingerprint state decides)
  function decide(st, batch, sha) {
    var mine = (batch && Array.isArray(batch.cards) ? batch.cards : []).filter(function (c) {
      return c && c.source_sha256 === sha && (c.status === 'pending' || c.status === 'failed' || c.status === 'discarded');
    })[0] || null;
    if (mine && mine.status === 'discarded') return 'restore';
    if (mine) return 'in_batch';
    var s = st && st.state;
    if (s === 'approved') return 'approved';
    if (s === 'pending') return st.same_transaction ? 'in_batch' : (st.can_move ? 'move' : 'pending_other');
    return 'read';
  }
  // a concurrency pool: worker(item, i) → Promise; results in order ({error} for a throw), at most n at a time
  function runPool(items, n, worker) {
    return new Promise(function (resolve) {
      var list = Array.isArray(items) ? items : [], out = new Array(list.length), next = 0, active = 0, done = 0;
      if (!list.length) { resolve(out); return; }
      function pump() {
        while (active < Math.max(1, n) && next < list.length) {
          (function (k) {
            active++;
            Promise.resolve().then(function () { return worker(list[k], k); })
              .then(function (v) { out[k] = v; }, function (e) { out[k] = { error: e }; })
              .then(function () { active--; done++; if (done === list.length) resolve(out); else pump(); });
          })(next++);
        }
      }
      pump();
    });
  }
  // the appointment object of a v3 reading (top level or inside ai_detail)
  function appointmentOf(res) {
    res = res || {};
    var a = res.appointment || (res.ai_detail && res.ai_detail.appointment) || null;
    return a && typeof a === 'object' ? a : null;
  }
  // what the card keeps of the reading (save_appointment_draft reading ≤ 60 000 bytes): {appointment, fields, warnings}
  function readingOf(res) {
    res = res || {};
    var ws = Array.isArray(res.warnings) ? res.warnings : (res.ai_detail && Array.isArray(res.ai_detail.warnings) ? res.ai_detail.warnings : []);
    var fs = Array.isArray(res.fields) ? res.fields : (res.ai_detail && Array.isArray(res.ai_detail.fields) ? res.ai_detail.fields : []);
    return {
      appointment: clone(appointmentOf(res)) || {},
      fields: fs.slice(0, 40).map(function (f) {
        return { name: str(f && f.name).slice(0, 60), value: f && f.value != null ? str(f.value).slice(0, 300) : null,
          confidence: f && typeof f.confidence === 'number' ? f.confidence : null };
      }),
      warnings: ws.slice(0, 30).map(function (w) { return { code: str(w && w.code).slice(0, 60), field: w && w.field ? str(w.field).slice(0, 60) : null, text: str(w && w.text).slice(0, 300) }; })
    };
  }
  // the saved reading (document_extractions, ⊆ supa.js EXT_INSERT) of a fresh appointment card reading
  function extractionRow(o) {
    var res = o.res || {}, file = o.file || {}, maxPage = 0;
    (res.fields || []).forEach(function (f) { if (f && f.page > maxPage) maxPage = f.page; });
    var row = {
      doc_type: 'appointment', source_name: String(file.name || 'appointment').slice(0, 255),
      source_sha256: o.sha256 || res.source_sha256 || '', source_mime: o.mime || null, source_size: file.size != null ? file.size : null,
      source_pages: maxPage ? Math.min(Math.max(maxPage, 1), 200) : null, engine: res.model || 'claude-opus-5-5', languages: 'auto',
      mean_confidence: res.mean_confidence == null ? null : Math.min(100, Math.max(0, Number(res.mean_confidence))),
      raw_text: String(res.raw_text || '').slice(0, 200000),
      extracted_fields: res.extracted_fields && typeof res.extracted_fields === 'object' ? res.extracted_fields : {},
      qr_payload: null, line_items: [], ai_usage_id: res.usage_id
    };
    if (res.ai_detail && typeof res.ai_detail === 'object') row.ai_detail = res.ai_detail;
    if (o.orgId) row.org_id = o.orgId;
    if (o.transactionId) row.transaction_id = o.transactionId;
    if (o.documentId) row.document_id = o.documentId;
    return row;
  }
  // a new card for save_appointment_draft
  function newCard(o) {
    var c = { source_sha256: o.sha256, file_name: String(o.file && o.file.name || 'card').slice(0, 255), file_size: Number(o.file && o.file.size) || 0,
      reading: o.reading || {} };
    if (o.mime) c.media_type = o.mime;
    if (isUuid(o.extractionId)) c.extraction_id = o.extractionId;
    if (isUuid(o.documentId)) c.document_id = o.documentId;
    return c;
  }
  // the value shown for a key: the staff review when it has the key (null = cleared), else the reading
  function cardValue(card, key) {
    var rv = card && card.review || {};
    if (has(rv, key)) return rv[key] == null ? '' : str(rv[key]);
    if (READ_KEYS.indexOf(key) === -1) return '';
    var a = card && card.reading && card.reading.appointment || {};
    if (key === 'appointment_at') return riyadhLocal(a.appointment_at || a.appointment_local || '');
    return a[key] == null ? '' : str(a[key]);
  }
  // the transaction container the card points at: the reviewed one, else the one with the card's number
  function containerOf(card, containers) {
    var list = Array.isArray(containers) ? containers : [], rv = card && card.review || {};
    if (has(rv, 'container_id') && rv.container_id) return list.filter(function (c) { return c.id === rv.container_id; })[0] || null;
    var no = normContainer(cardValue(card, 'container_no'));
    return no ? list.filter(function (c) { return normContainer(c.container_no) === no; })[0] || null : null;
  }
  // what is still missing before the card can become a movement (the rules of app.appt_card_approve + save_movement);
  // an empty entry is skipped at approval (never a movement), so nothing is missing for it; an unknown movement type fails
  // approval (MRS_REQUIRED movement_type) until staff choose it
  function cardMissing(card, containers, cargo) {
    var mt = cardValue(card, 'movement_type');
    if (mt === 'empty_entry') return [];
    if (mt !== 'full_exit') return ['movement_type'];
    var out = [];
    if (cargo !== 'roro' && !containerOf(card, containers)) out.push('container');
    if (dateTimeState(cardValue(card, 'appointment_at')) !== 'ok') out.push('appointment_at');
    ['driver_name', 'driver_phone', 'truck_plate', 'party_type'].forEach(function (k) { if (blank(cardValue(card, k))) out.push(k); });
    var pt = cardValue(card, 'party_type');
    // a company / supplier chosen by carrier_id needs no typed name (the server fills it from the carrier party)
    if (pt && blank(cardValue(card, 'party_name')) && blank(cardValue(card, 'carrier_id'))
        && !(pt === 'direct' && !blank(cardValue(card, 'driver_name')))) out.push('party_name');
    return out;
  }
  function normRef(v) { return western(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // the card section that holds the transaction data (exit for a full exit, entry for an empty entry)
  function cardSection(card) {
    var a = card && card.reading && card.reading.appointment || {};
    var s = cardValue(card, 'movement_type') === 'empty_entry' ? a.entry : a.exit;
    return s && typeof s === 'object' ? s : {};
  }
  // legacy compareAppointmentWithTransaction_: the card's B/L / declaration against the transaction's (null = nothing to
  // compare); ref: {bl_numbers [], declaration_numbers []} of the batch
  function refMatch(card, refs) {
    var sec = cardSection(card), out = { bl: null, decl: null };
    var bls = (refs && Array.isArray(refs.bl_numbers) ? refs.bl_numbers : []).map(normRef).filter(Boolean);
    var decls = (refs && Array.isArray(refs.declaration_numbers) ? refs.declaration_numbers : []).map(normRef).filter(Boolean);
    var b = normRef(sec.bl_number), d = normRef(sec.declaration_number);
    if (b && bls.length) out.bl = bls.indexOf(b) !== -1;
    if (d && decls.length) out.decl = decls.indexOf(d) !== -1;
    return out;
  }
  // the hints shown on a card row (not blocking): a phone that is not 05XXXXXXXX, a card container that is not the transaction's,
  // a card B/L / declaration that is not the transaction's, amounts a trip-finance user entered (hidden from this role)
  function cardHints(card, containers, cargo, refs) {
    var out = [], ph = cardValue(card, 'driver_phone');
    if (ph && !normPhone(ph)) out.push('phone_format');
    var no = normContainer(cardValue(card, 'container_no'));
    if (cargo !== 'roro' && no && !(card.review && card.review.container_id) && !containerOf(card, containers)) out.push('container_not_in_tx');
    if (no && !CTR_RE.test(no)) out.push('container_format');
    if (cardValue(card, 'movement_type') === 'empty_entry') out.push('empty_entry_skip');
    if (!cardValue(card, 'movement_type')) out.push('movement_unknown');
    var m = refMatch(card, refs);
    if (m.bl === false) out.push('bl_mismatch');
    if (m.decl === false) out.push('decl_mismatch');
    if (card && card.amounts_hidden) out.push('amounts_hidden');
    return out;
  }
  // a review edit: '' clears (null) a key the reading has, and removes a review-only key; container picks set id + number
  function setReview(review, key, value, card) {
    var r = clone(review || {}), v = value == null ? '' : String(value);
    if (key === 'container_id') {
      if (!v) { r.container_id = null; r.container_no = null; return r; }
      r.container_id = v.split('|')[0];
      if (v.indexOf('|') > 0) r.container_no = v.split('|')[1];
      return r;
    }
    if (key === 'driver_phone' && v) { var p = normPhone(v); if (p) v = p; }
    if (MONEY_KEYS.indexOf(key) !== -1) {
      var n = v.trim() === '' ? null : Number(western(v).replace(/,/g, ''));
      if (n == null) delete r[key]; else r[key] = isFinite(n) ? n : v;
      return r;
    }
    if (v.trim() === '') {
      var read = card && card.reading && card.reading.appointment || {};
      var rv = key === 'appointment_at' ? (read.appointment_at || read.appointment_local) : read[key];
      if (READ_KEYS.indexOf(key) !== -1 && !blank(rv)) r[key] = null;
      else delete r[key];
      return r;
    }
    r[key] = v;
    return r;
  }
  // the review a non-finance user may send (save_appointment_draft refuses cost / sell: MRS_FORBIDDEN cost)
  function reviewPayload(review, finance) {
    var r = {};
    Object.keys(review || {}).forEach(function (k) {
      if (REVIEW_KEYS.indexOf(k) === -1) return;
      if (!finance && MONEY_KEYS.indexOf(k) !== -1) return;
      r[k] = review[k];
    });
    return r;
  }
  function counts(batch) {
    var c = { total: 0, pending: 0, approved: 0, skipped: 0, failed: 0, discarded: 0, cancelled: 0 };
    (batch && Array.isArray(batch.cards) ? batch.cards : []).forEach(function (x) { c.total++; if (has(c, x.status)) c[x.status]++; });
    return c;
  }
  function openBatch(b) { return !!b && (b.status === 'pending' || b.status === 'partial'); }
  function approvable(card) { return !!card && (card.status === 'pending' || card.status === 'failed'); }
  function editableCard(card) { return !!card && (card.status === 'pending' || card.status === 'failed' || card.status === 'discarded'); }
  // what the confirm dialog says: the cards that become movements, are skipped (empty entry), still lack data (an unknown
  // movement type included), or carry a B/L / declaration that is not the transaction's
  function approvePlan(cards, containers, cargo, refs) {
    var p = { total: 0, movements: 0, skipped: 0, incomplete: 0, mismatch: 0 };
    (cards || []).forEach(function (c) {
      if (!approvable(c)) return;
      p.total++;
      if (cardValue(c, 'movement_type') === 'empty_entry') { p.skipped++; return; }
      if (cardMissing(c, containers, cargo).length) p.incomplete++; else p.movements++;
      var m = refMatch(c, refs);
      if (m.bl === false || m.decl === false) p.mismatch++;
    });
    return p;
  }
  // may a user with these memberships write for a branch (org-wide = branch null)
  function branchCan(memberships, orgId, branchId, roles) {
    return (Array.isArray(memberships) ? memberships : []).some(function (m) {
      return m && (!orgId || !m.org_id || m.org_id === orgId) && (m.branch_id == null || m.branch_id === branchId)
        && (roles || []).indexOf(m.role) !== -1;
    });
  }
  // may an approval go now: nothing being read (each read card bumps the draft version), no unsaved / failed autosave
  function approveBlock(st) {
    st = st || {};
    if (st.reading > 0) return 'reading';
    if (st.saveError) return 'save_error';
    if (st.pending && Object.keys(st.pending).length) return 'unsaved';
    return null;
  }
  // the idempotency key: the same approval (version + cards) retried keeps its key; anything else is a new approval
  function approveKey(prev, version, ids, gen) {
    var sig = String(version) + '|' + (ids ? ids.slice().sort().join(',') : '*');
    if (prev && prev.sig === sig) return prev;
    return { sig: sig, key: gen ? gen() : null };
  }
  function resultSummary(r) {
    r = r || {};
    var c = r.counts || {}, out = { saved: Number(c.saved) || 0, already_existed: Number(c.already_existed) || 0, skipped: Number(c.skipped) || 0, failed: Number(c.failed) || 0 };
    out.results = (Array.isArray(r.results) ? r.results : []).map(function (x) {
      return { card_id: x.card_id, seq: x.seq, file_name: x.file_name, outcome: OUTCOMES.indexOf(x.outcome) !== -1 ? x.outcome : 'failed', code: x.code || null, detail: x.detail || null };
    });
    out.status = r.status || null;
    return out;
  }
  function rejectReason(e) {
    if (!e || e.code !== 'MRS_AI_WRONG_DOCUMENT') return null;
    var r = e.field || e.detail || '';
    return REJECT_REASONS.indexOf(r) !== -1 ? r : 'not_appointment_ticket';
  }
  // a known error code + detail → the appt dictionary key (else the API message)
  var ERR_KEYS = {
    'MRS_APPT_CARD_DUPLICATE:approved': 'e_dup_approved', 'MRS_APPT_CARD_DUPLICATE:pending_other': 'e_dup_pending_other',
    'MRS_APPT_CARD_DUPLICATE:pending': 'e_dup_pending', 'MRS_APPT_DRAFT_LIMIT:cards': 'e_limit_cards', 'MRS_APPT_DRAFT_LIMIT:size': 'e_limit_size',
    'MRS_APPT_PARTY_REQUIRED:party_type': 'e_party_type', 'MRS_APPT_PARTY_REQUIRED:party_name': 'e_party_name',
    'MRS_DATETIME_REQUIRED:appointment_at': 'e_datetime', 'MRS_REQUIRED:appointment_at': 'e_datetime',
    'MRS_INVALID:driver_phone': 'e_phone', 'MRS_REQUIRED:driver_phone': 'e_phone', 'MRS_REQUIRED:driver_name': 'e_driver',
    'MRS_INVALID:driver_name': 'e_driver', 'MRS_INVALID:truck_plate': 'e_plate', 'MRS_REQUIRED:truck_plate': 'e_plate',
    'MRS_FORBIDDEN:cost': 'e_cost', 'MRS_FORBIDDEN:role': 'e_role', 'MRS_INVALID:same_transaction': 'e_same_tx',
    'MRS_NOT_FOUND:transaction': 'e_no_tx', 'MRS_REQUIRED:target_ref': 'e_target_ref', 'MRS_REQUIRED:transaction_id': 'e_no_tx',
    'MRS_NOTE_REQUIRED:reason': 'e_reason', 'MRS_APPT_DRAFT_STALE:': 'e_stale', 'MRS_APPT_DRAFT_APPROVED:': 'e_draft_approved',
    'MRS_DUPLICATE_APPOINTMENT:': 'e_dup_appointment', 'MRS_REQUIRED:container_id': 'e_container',
    'MRS_REQUIRED:movement_type': 'e_movement_type'
  };
  function errKey(e) {
    if (!e || !e.code) return null;
    var k = e.code + ':' + (e.field || e.detail || '');
    if (has(ERR_KEYS, k)) return ERR_KEYS[k];
    if (e.code === 'MRS_APPT_CONTAINER_NOT_IN_TX') return 'e_container_not_in_tx';
    if (e.code === 'MRS_APPT_DRAFT_CLOSED') return 'e_closed';
    return null;
  }

  var PURE = {
    CARD_MAX: CARD_MAX, BATCH_BYTES: BATCH_BYTES, CARD_MAX_BYTES: CARD_MAX_BYTES, CONCURRENCY: CONCURRENCY, AUTOSAVE_MS: AUTOSAVE_MS,
    MOVEMENT_TYPES: MOVEMENT_TYPES, PARTY_TYPES: PARTY_TYPES, CARD_STATUSES: CARD_STATUSES, BATCH_STATUSES: BATCH_STATUSES, OUTCOMES: OUTCOMES,
    REJECT_REASONS: REJECT_REASONS, REVIEW_KEYS: REVIEW_KEYS, READ_KEYS: READ_KEYS, MAIN_COLS: MAIN_COLS, DETAIL_KEYS: DETAIL_KEYS,
    MISSING: MISSING, AI_WARNINGS: AI_WARNINGS, ERR_KEYS: ERR_KEYS,
    isUuid: isUuid, normContainer: normContainer, normPhone: normPhone, parseHash: parseHash, pageLink: pageLink, txLink: txLink,
    riyadhLocal: riyadhLocal, dateTimeState: dateTimeState, mediaType: mediaType, fileProblem: fileProblem, liveCards: liveCards,
    planFiles: planFiles, decide: decide, runPool: runPool, appointmentOf: appointmentOf, readingOf: readingOf, extractionRow: extractionRow,
    newCard: newCard, cardValue: cardValue, containerOf: containerOf, cardMissing: cardMissing, cardHints: cardHints, setReview: setReview,
    reviewPayload: reviewPayload, counts: counts, openBatch: openBatch, approvable: approvable, editableCard: editableCard,
    approvePlan: approvePlan, approveKey: approveKey, resultSummary: resultSummary, rejectReason: rejectReason, errKey: errKey,
    refMatch: refMatch, branchCan: branchCan, approveBlock: approveBlock
  };
  window.MarsaApptCards = { VERSION: 'appt-ui-1', pure: PURE };

  /* ==================================================================
     Page UI (ocr.html only: #appt-section)
     ================================================================== */
  function ready(fn) {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var section = document.getElementById('appt-section');
    var root = document.getElementById('appt-root');
    if (!section || !root) return;
    var API = window.MarsaApi || null;
    var Shell = window.MarsaShell || null;
    var I18N = window.MarsaI18n || null;
    var M = window.Marsa || {};
    var toast = Shell && typeof Shell.toast === 'function' ? function (m, t) { Shell.toast(m, t); }
      : (M.toast || function (m) { try { console.log(m); } catch (e) { /* noop */ } });

    function T(key, vars) {
      var k = 'appt.' + key;
      return I18N && typeof I18N.t === 'function' && (!I18N.has || I18N.has(k)) ? I18N.t(k, vars) : key;
    }
    function lang() { return I18N && typeof I18N.lang === 'function' && I18N.lang() === 'en' ? 'en' : 'ar'; }
    function hasFn(fn) { return !!(API && typeof API[fn] === 'function'); }
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function btn(text, cls, fn) {
      var b = el('button', 'btn btn-sm ' + (cls || 'btn-ghost'), text);
      b.type = 'button';
      if (fn) b.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); fn(b); });
      return b;
    }
    function bdi(text, ltr) { var b = el('bdi', ltr ? 'num' : null, text); b.dir = ltr ? 'ltr' : 'auto'; return b; }
    function alertBox(type, text) {
      var a = el('div', 'alert alert-' + type + ' appt-alert');
      a.setAttribute('role', type === 'danger' ? 'alert' : 'status');
      a.appendChild(el('span', null, text));
      return a;
    }
    function errMsg(e) {
      var k = errKey(e);
      if (k) return T(k, { f: (e && (e.field || e.detail)) || '' });
      if (e && e.raw === undefined && typeof e.message === 'string' && e.message && !/^MRS_[A-Z_]+(:.*)?$/.test(e.message)) return e.message;
      if (API && typeof API.errorMessage === 'function') { try { var m = API.errorMessage(e); if (m) return m; } catch (x) { /* below */ } }
      return (e && e.message) || T('err_generic');
    }
    function fmtDate(iso) {
      if (!iso) return '';
      try {
        if (I18N && I18N.fmtDate) return I18N.fmtDate(iso, { time: true });
        return new Date(iso).toLocaleString(lang() === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn-ca-gregory');
      } catch (e) { return String(iso); }
    }
    function fmtSize(n) { n = Number(n) || 0; return n >= 1048576 ? (Math.round(n / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
    function announce(msg) { var s = document.getElementById('appt-live'); if (s) s.textContent = msg; }
    function askConfirm(o) {
      if (Shell && typeof Shell.confirm === 'function') return Promise.resolve(Shell.confirm(o)).then(function (v) { return !!v; }, function () { return false; });
      return Promise.resolve(window.confirm((o.title ? o.title + '\n\n' : '') + (o.text || '')));
    }
    function uuid() { return API && API.util && API.util.uuid ? API.util.uuid() : null; }
    function fileB64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
        fr.onerror = function () { reject(new Error('read')); };
        fr.readAsDataURL(file);
      });
    }
    function sha256(file) {
      if (API && API.util && API.util.sha256Hex) return Promise.resolve(API.util.sha256Hex(file)).catch(function () { return ''; });
      if (!window.crypto || !crypto.subtle || !file.arrayBuffer) return Promise.resolve('');
      return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).catch(function () { return ''; });
    }
    function res0(r) { return r || { data: null, error: { code: 'MRS_UNAVAILABLE' } }; }

    /* ---------------------------------------------------------------
       State + access gate
       --------------------------------------------------------------- */
    var ONLINE = !!(API && API.isOnline && API.isOnline());
    var S = {
      staff: false, writer: false, ai: false, remaining: null, orgId: null, route: {}, tx: null, txError: null,
      batch: null, batchError: null, loading: false, queue: [], reading: 0, docs: null, saveChain: Promise.resolve(),
      pending: {}, timer: null, saving: false, saveError: null, saved: false, stale: false, local: {}, open: {}, selected: {},
      approving: false, approveError: null, idem: null, result: null, notice: null, busy: false, seq: 0
    };
    function shellOrg() {
      if (!Shell || typeof Shell.orgId !== 'function') return null;
      try { var o = Shell.orgId(); return typeof o === 'string' && o ? o : null; } catch (e) { return null; }
    }
    function orgP() {
      if (S.orgId) return Promise.resolve(S.orgId);
      var o = shellOrg();
      if (o) { S.orgId = o; return Promise.resolve(o); }
      if (!API || !API.activeOrgId) return Promise.resolve(null);
      return API.activeOrgId().then(function (r) { S.orgId = r && !r.error ? r.data || null : null; return S.orgId; }, function () { return null; });
    }
    function init() {
      if (!ONLINE || !API || !hasFn('getAppointmentDraft') || !hasFn('saveAppointmentDraft')) { section.hidden = true; return; }
      var shellReady = Shell && Shell.ready && typeof Shell.ready.then === 'function' ? Shell.ready : Promise.resolve(null);
      shellReady.then(function () { return API.getSession(); }).then(function (s) {
        if (!s || s.error || !s.data) return false;
        return API.isStaff().then(function (r) { return !r.error && !!r.data; });
      }).then(function (staff) {
        S.staff = !!staff;
        if (!S.staff) { section.hidden = true; return null; }
        var R = Shell && Shell.R && Shell.R.transportWriter;
        S.writerAny = Shell && typeof Shell.can === 'function' && R ? !!Shell.can(R) : true;
        S.writer = S.writerAny;
        return orgP().then(function (oid) {
          return hasFn('aiAccess') ? API.aiAccess(oid || undefined).then(function (r) {
            S.ai = !!(r && !r.error && r.data && r.data.can_use === true);
            S.remaining = S.ai && r.data.daily_remaining != null ? Number(r.data.daily_remaining) : null;
          }, function () { S.ai = false; }) : null;
        });
      }).then(function () { if (S.staff) route(); }).catch(function () { section.hidden = true; });
    }
    window.addEventListener('hashchange', function () { if (S.staff) route(); });
    window.addEventListener('beforeunload', function (e) {
      if (!Object.keys(S.pending).length && !S.reading) return;
      flush();
      e.preventDefault(); e.returnValue = '';
    });
    window.addEventListener('marsa:langchange', function () { if (S.staff && !section.hidden) render(); });
    window.addEventListener('marsa:orgchange', function () { S.orgId = null; S.tx = null; S.batch = null; if (S.staff) route(); });

    function route() {
      var h = parseHash(location.hash);
      if (!h.tx) { S.route = h; section.hidden = true; return; }
      var same = S.route.tx === h.tx;
      S.route = h;
      section.hidden = false;
      if (!same) {
        S.tx = null; S.batch = null; S.queue = []; S.docs = null; S.pending = {}; S.local = {}; S.open = {}; S.selected = {};
        S.result = null; S.approveError = null; S.notice = null; S.stale = false; S.saveError = null; S.idem = null;
      }
      load();
      var t = document.getElementById('appt-title');
      if (t) { try { t.focus({ preventScroll: false }); } catch (e) { t.focus(); } }
    }
    function load() {
      var txId = S.route.tx, my = ++S.seq;
      S.loading = true; S.batchError = null; S.txError = null;
      render();
      var txP = hasFn('getTransaction') ? API.getTransaction(txId).then(function (r) {
        if (r && !r.error && r.data) return r.data;
        S.txError = r && r.error ? r.error : { code: 'MRS_NOT_FOUND', field: 'transaction' };
        return null;
      }, function (e) { S.txError = e; return null; }) : Promise.resolve(null);
      return Promise.all([txP, API.getAppointmentDraft(txId)]).then(function (rs) {
        if (my !== S.seq) return;
        S.loading = false;
        S.tx = rs[0];
        S.writer = txWriter(S.tx);
        var r = res0(rs[1]);
        if (r.error) { S.batchError = r.error; S.batch = null; }
        else setBatch(r.data || null);
        render();
      }, function (e) { if (my === S.seq) { S.loading = false; S.batchError = e; render(); } });
    }
    // a fresh batch from the server: the local (unsaved) review of each card is kept over it
    function setBatch(b) {
      S.batch = b;
      var keep = {};
      (b && Array.isArray(b.cards) ? b.cards : []).forEach(function (c) {
        keep[c.id] = S.pending[c.id] && S.local[c.id] ? S.local[c.id] : clone(c.review || {});
      });
      S.local = keep;
    }
    // a transport writer of THIS transaction's branch (a writer in another branch only reads here: no AI read is spent
    // on a save the server would refuse); without the shell context, the any-branch answer
    function txWriter(tx) {
      var R = Shell && Shell.R && Shell.R.transportWriter, ctx = Shell && typeof Shell.context === 'function' ? Shell.context() : null;
      if (!R || !ctx || !Array.isArray(ctx.memberships) || !tx || !tx.branch_id) return !!S.writerAny;
      return branchCan(ctx.memberships, tx.org_id || S.orgId, tx.branch_id, R);
    }
    function cardView(c) { var v = clone(c); v.review = S.local[c.id] || c.review || {}; return v; }
    function canEdit() { return !!S.batch && openBatch(S.batch) && S.batch.can_edit !== false && !S.approving && !S.busy && !S.stale; }
    function canUpload() {
      return S.ai && S.writer && !!S.tx && !S.tx.cancelled_at && (!S.batch || (openBatch(S.batch) && S.batch.can_edit !== false)) && !S.busy && !S.approving;
    }

    /* ---------------------------------------------------------------
       Render
       --------------------------------------------------------------- */
    // a full repaint keeps the focused review cell (card + key) and its caret, so a card that finishes reading
    // while staff edit another row does not steal the focus
    function render() {
      var fx = null, ae = document.activeElement;
      if (ae && ae.getAttribute && ae.getAttribute('data-key') && root.contains && root.contains(ae)) {
        var tr = ae; while (tr && tr.getAttribute && !tr.getAttribute('data-card')) tr = tr.parentNode;
        fx = { key: ae.getAttribute('data-key'), card: tr && tr.getAttribute ? tr.getAttribute('data-card') : null, start: ae.selectionStart, end: ae.selectionEnd };
      }
      paint();
      if (fx && fx.card) {
        var row = root.querySelector('[data-card="' + fx.card + '"]'), n = row && row.querySelector('[data-key="' + fx.key + '"]');
        if (n && !n.disabled) { try { n.focus(); if (fx.start != null && n.setSelectionRange) n.setSelectionRange(fx.start, fx.end); } catch (e) { /* not a text input */ } }
      }
    }
    // the upload queue alone (the states of the files being read): the review table is left as it is
    var queueHost = null;
    function paintQueue() {
      if (!queueHost || !queueHost.parentNode) { render(); return; }
      queueHost.textContent = '';
      if (S.queue.length) queueHost.appendChild(renderQueue());
    }
    function paint() {
      root.textContent = '';
      root.appendChild(renderHead());
      if (S.loading) { root.appendChild(el('p', 'text-sm text-muted', T('loading'))); return; }
      if (S.batchError) {
        root.appendChild(alertBox('danger', errMsg(S.batchError)));
        root.appendChild(btn(T('reload'), 'btn-secondary', function () { load(); }));
        return;
      }
      if (S.notice) root.appendChild(S.notice.node ? S.notice.node : alertBox(S.notice.type || 'info', S.notice.text));
      root.appendChild(renderUpload());
      queueHost = el('div', 'appt-queue-host');
      root.appendChild(queueHost);
      if (S.queue.length) queueHost.appendChild(renderQueue());
      if (S.result) root.appendChild(renderResult());
      if (S.batch) root.appendChild(renderBatch());
      else root.appendChild(el('p', 'text-sm text-muted appt-empty', T('no_draft')));
    }
    function renderHead() {
      var box = el('div', 'appt-head');
      var dl = el('dl', 'appt-meta');
      function row(k, v) { if (v == null || v === '') return; var d = el('div'); d.appendChild(el('dt', null, k)); var dd = el('dd'); dd.appendChild(typeof v === 'string' ? bdi(v) : v); d.appendChild(dd); dl.appendChild(d); }
      var tx = S.tx;
      if (S.route.tx) { var a = el('a', null, (tx && tx.ref) || (S.batch && S.batch.ref) || T('tx_open')); a.href = txLink(S.route.tx); row(T('m_tx'), a); }
      if (tx && tx.clients && tx.clients.name_ar) row(T('m_client'), tx.clients.name_ar);
      if (tx && tx.cargo_unit_type === 'roro') row(T('m_cargo'), T('cargo_roro'));
      if (S.batch) row(T('m_draft'), T('bst_' + S.batch.status));
      if (dl.children.length) box.appendChild(dl);
      if (S.txError) box.appendChild(alertBox('danger', errMsg(S.txError)));
      if (tx && tx.cancelled_at) box.appendChild(alertBox('warning', T('tx_cancelled')));
      if (!S.writer) box.appendChild(alertBox('info', T('read_only_role')));
      box.appendChild(el('p', 'form-hint appt-rule', T('draft_rule')));
      return box;
    }

    /* ---------- upload + fingerprint check + reading ---------- */
    function renderUpload() {
      var box = el('div', 'ocr-block appt-upload');
      box.appendChild(el('h3', 'appt-h3', T('up_title')));
      box.appendChild(el('p', 'text-sm text-muted', T('up_lead')));
      if (!S.ai) box.appendChild(alertBox('warning', T('ai_off')));
      else if (S.remaining != null) box.appendChild(el('p', 'text-sm text-muted', T('ai_remaining', { n: S.remaining })));
      var live = liveCards(S.batch).length;
      box.appendChild(el('p', 'text-sm appt-limits', T('limits', { n: live, max: CARD_MAX })));
      var ok = canUpload();
      var drop = el('label', 'dropzone appt-drop');
      var inp = el('input'); inp.type = 'file'; inp.id = 'appt-files'; inp.multiple = true; inp.setAttribute('multiple', '');
      inp.accept = '.jpg,.jpeg,.png,.webp,.gif,.pdf,image/jpeg,image/png,image/webp,image/gif,application/pdf';
      inp.className = 'appt-file'; inp.disabled = !ok || S.reading > 0;
      inp.setAttribute('aria-label', T('up_files_aria'));
      inp.addEventListener('change', function () { var fs = this.files ? Array.prototype.slice.call(this.files) : []; this.value = ''; pickFiles(fs); });
      drop.appendChild(inp);
      drop.appendChild(el('span', 'dropzone-title', T('up_drop')));
      drop.appendChild(el('span', 'dropzone-sub', T('formats')));
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-dragover'); }); });
      ['dragleave', 'dragend'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('is-dragover'); }); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); drop.classList.remove('is-dragover');
        if (canUpload() && !S.reading && e.dataTransfer && e.dataTransfer.files) pickFiles(Array.prototype.slice.call(e.dataTransfer.files));
      });
      box.appendChild(drop);
      box.appendChild(el('p', 'form-hint', T('dedupe_hint')));
      return box;
    }
    function qItem(f) { return { id: 'q' + Math.random().toString(36).slice(2), file: f, name: String(f && f.name || ''), size: Number(f && f.size) || 0, state: 'hashing', why: null, st: null, sha: '' }; }
    function pickFiles(files) {
      if (!files.length || !canUpload()) return;
      S.result = null; S.notice = null;
      var items = files.map(qItem), inflight = { count: 0, bytes: 0 };
      S.queue.forEach(function (q) { if (['hashing', 'checking', 'queued', 'reading', 'saving'].indexOf(q.state) !== -1) { inflight.count++; inflight.bytes += q.size; } });
      var plan = planFiles(files, S.batch, inflight), accepted = {};
      plan.accepted.forEach(function (i) { accepted[i] = 1; });
      plan.rejected.forEach(function (x) { items[x.i].state = 'refused'; items[x.i].why = x.reason; });
      items.forEach(function (q, i) {
        if (!accepted[i]) return;
        var p = fileProblem(q.file);
        if (p) { q.state = 'refused'; q.why = p; }
      });
      S.queue = items.concat(S.queue.filter(function (q) { return ['done', 'restored', 'moved_here'].indexOf(q.state) === -1; }));
      render();
      var todo = items.filter(function (q) { return q.state === 'hashing'; });
      if (!todo.length) return;
      S.reading++;
      refreshActions();                      // no approval while cards are being read (each read bumps the draft version)
      Promise.all(todo.map(function (q) { return sha256(q.file).then(function (h) { q.sha = String(h || '').toLowerCase(); }); })).then(function () {
        // the same file twice in this selection: kept once
        var seen = {};
        todo.forEach(function (q) {
          if (!/^[0-9a-f]{64}$/.test(q.sha)) { q.state = 'error'; q.why = 'hash'; return; }
          if (seen[q.sha]) { q.state = 'refused'; q.why = 'dup_selection'; return; }
          seen[q.sha] = 1; q.state = 'checking';
        });
        var check = todo.filter(function (q) { return q.state === 'checking'; });
        paintQueue();
        if (!check.length) return null;
        return orgP().then(function (oid) {
          return hasFn('appointmentCardState') ? API.appointmentCardState(S.route.tx, check.map(function (q) { return q.sha; }), { orgId: oid || undefined })
            : { data: [], error: null };
        }).then(function (r) {
          r = res0(r);
          if (r.error) { check.forEach(function (q) { q.state = 'error'; q.err = r.error; }); return null; }
          var bySha = {};
          (Array.isArray(r.data) ? r.data : []).forEach(function (x) { if (x && x.sha256) bySha[String(x.sha256).toLowerCase()] = x; });
          check.forEach(function (q) {
            q.st = bySha[q.sha] || null;
            var d = decide(q.st, S.batch, q.sha);
            q.state = d === 'read' ? 'queued' : d;
          });
          paintQueue();
          var restore = check.filter(function (q) { return q.state === 'restore'; });
          if (restore.length) restoreCards(restore);
          var reads = check.filter(function (q) { return q.state === 'queued'; });
          return runPool(reads, CONCURRENCY, readOne);
        });
      }).then(function () { S.reading--; render(); announce(T('read_all_done')); }, function (e) { S.reading--; S.notice = { type: 'danger', text: errMsg(e) }; render(); });
    }
    function docsBySha() {
      if (S.docs) return Promise.resolve(S.docs);
      if (!hasFn('listDocuments')) return Promise.resolve({});
      return API.listDocuments({ transactionId: S.route.tx }).then(function (r) {
        var m = {};
        (r && !r.error && Array.isArray(r.data) ? r.data : []).forEach(function (d) { if (d && d.sha256 && !d.voided_at) m[d.sha256] = d.id; });
        S.docs = m; return m;
      }, function () { return {}; });
    }
    // the card file as a document of the transaction (kind 'appointment'); a file already uploaded here is reused
    function ensureDoc(q) {
      return docsBySha().then(function (m) {
        if (m[q.sha]) return m[q.sha];
        if (!hasFn('uploadDocument')) return null;
        return API.uploadDocument({ file: q.file, transactionId: S.route.tx, kind: 'appointment', source: 'upload' }).then(function (r) {
          if (r && !r.error && r.data && r.data.id) { m[q.sha] = r.data.id; return r.data.id; }
          q.docWarn = true;      // the card stays usable without its file link (document_id is optional)
          return null;
        }, function () { q.docWarn = true; return null; });
      });
    }
    function readOne(q) {
      var txId = S.route.tx, mime = mediaType(q.file), res = null, extId = null;
      q.state = 'reading'; paintQueue();
      return fileB64(q.file).then(function (b64) {
        return orgP().then(function (oid) {
          return API.aiExtract({ orgId: oid || undefined, docType: 'appointment_ticket', file: { media_type: mime, data_b64: b64 },
            transactionId: txId, lang: lang(), promptVersion: 'ai-doc-v3' });
        });
      }).then(function (r) {
        r = res0(r);
        if (r.error) {
          var why = rejectReason(r.error);
          if (why) { if (S.remaining != null) S.remaining = Math.max(0, S.remaining - 1); q.state = 'rejected'; q.why = why; paintQueue(); return null; }
          throw r.error;
        }
        res = r.data || {};
        if (!res.reused && S.remaining != null) S.remaining = Math.max(0, S.remaining - 1);
        q.state = 'saving'; paintQueue();
        return ensureDoc(q).then(function (docId) {
          q.docId = docId;
          if (res.reused && isUuid(res.extraction_id)) {
            extId = res.extraction_id;
            if (appointmentOf(res) || !hasFn('getExtraction')) return null;
            return API.getExtraction(extId).then(function (x) { if (x && !x.error && x.data) res = { ai_detail: x.data.ai_detail, fields: [], warnings: [] }; });
          }
          var row = extractionRow({ res: res, file: q.file, sha256: q.sha, mime: mime, orgId: S.orgId, transactionId: txId, documentId: docId });
          return API.saveExtraction(row).then(function (s) {
            if (s && !s.error && s.data) { extId = s.data.id; return null; }
            if (!s || !s.error || s.error.code !== 'MRS_EXTRACTION_DUPLICATE' || !hasFn('findExtractionBySource')) throw (s && s.error) || new Error(T('err_generic'));
            return API.findExtractionBySource({ orgId: S.orgId || undefined, sha256: q.sha, transactionId: txId }).then(function (x) {
              if (x.error || !x.data || x.data.doc_type !== 'appointment') throw s.error;
              extId = x.data.id;
            });
          });
        }).then(function () {
          return addCard(q, newCard({ sha256: q.sha, file: q.file, mime: mime, extractionId: extId, documentId: q.docId, reading: readingOf(res) }));
        });
      }).then(null, function (e) { q.state = 'error'; q.err = e; paintQueue(); });
    }
    // the saves of this tab are serialized (one at a time), so each sees the version of the previous one
    function chain(fn) {
      var p = S.saveChain.then(fn, fn);
      S.saveChain = p.then(function () { return null; }, function () { return null; });
      return p;
    }
    function addCard(q, card) {
      return chain(function () {
        var txId = S.route.tx;
        var send = function (batchId) { return API.saveAppointmentDraft(txId, batchId ? { batchId: batchId, cards: [card] } : { cards: [card] }); };
        return send(S.batch && openBatch(S.batch) ? S.batch.id : null).then(function (r) {
          r = res0(r);
          if (r.error && r.error.code === 'MRS_APPT_DRAFT_EXISTS') {
            return API.getAppointmentDraft(txId).then(function (g) {
              g = res0(g);
              if (g.error || !g.data) throw g.error || r.error;
              return send(g.data.id);
            });
          }
          return r;
        }).then(function (r) {
          r = res0(r);
          if (r.error) {
            if (r.error.code === 'MRS_APPT_CARD_DUPLICATE') { q.state = r.error.field === 'approved' ? 'approved' : (r.error.field === 'pending_other' ? 'pending_other' : 'in_batch'); }
            else { q.state = 'error'; q.err = r.error; }
            paintQueue(); return;
          }
          setBatch(r.data);
          q.state = 'done';
          render();
        });
      });
    }
    function restoreCards(items) {
      var cards = items.map(function (q) {
        var c = (S.batch.cards || []).filter(function (x) { return x.source_sha256 === q.sha; })[0];
        return c ? { card_id: c.id, status: 'pending' } : null;
      }).filter(Boolean);
      if (!cards.length) return;
      chain(function () {
        return API.saveAppointmentDraft(S.route.tx, { batchId: S.batch.id, version: S.batch.version, cards: cards }).then(function (r) {
          r = res0(r);
          items.forEach(function (q) { if (r.error) { q.state = 'error'; q.err = r.error; } else q.state = 'restored'; });
          if (r.error && r.error.code === 'MRS_APPT_DRAFT_STALE') S.stale = true;
          if (!r.error) setBatch(r.data);
          render();
        });
      });
    }
    function moveHere(q) {
      if (!q.st || !q.st.batch_id || !S.tx || !S.tx.ref) return;
      askConfirm({ title: T('mh_title'), text: T('mh_text', { from: q.st.ref || '—', to: S.tx.ref }), okText: T('mh_ok') }).then(function (yes) {
        if (!yes) return;
        S.busy = true; render();
        // the file is kept here first (kind appointment): the moved card then points at this transaction's copy
        flush().then(function () { return q.file && q.sha ? ensureDoc(q) : null; }).then(function () {
          return API.moveAppointmentDraft(q.st.batch_id, S.tx.ref, T('mh_reason'));
        }).then(function (r) {
          r = res0(r); S.busy = false;
          if (r.error) { q.state = 'error'; q.err = r.error; render(); return; }
          q.state = 'moved_here';
          toast(T('mh_done', { ref: S.tx.ref }), 'success');
          load();
        });
      });
    }
    function renderQueue() {
      var box = el('div', 'appt-queue');
      box.appendChild(el('h3', 'appt-h3', T('q_title')));
      var ul = el('ul', 'appt-qlist');
      S.queue.forEach(function (q) {
        var li = el('li', 'appt-q is-' + q.state);
        var head = el('div', 'appt-q-head');
        head.appendChild(bdi(q.name));
        head.appendChild(el('span', 'adm-sub', ' · ' + fmtSize(q.size)));
        head.appendChild(el('span', 'badge badge-sm badge-' + qTone(q.state), T('qs_' + q.state)));
        li.appendChild(head);
        var line = qLine(q);
        if (line) { var p = el('p', 'appt-q-line', line); if (q.state === 'error' || q.state === 'rejected' || q.state === 'approved') p.setAttribute('role', 'alert'); li.appendChild(p); }
        if (q.docWarn) li.appendChild(el('p', 'appt-q-line text-muted', T('doc_warn')));
        if (q.state === 'move' && S.writer && S.tx && S.tx.ref) li.appendChild(btn(T('mh_btn'), 'btn-secondary', function () { moveHere(q); }));
        if (q.state === 'move' && q.st && q.st.transaction_id) { var a = el('a', 'appt-q-link', T('open_other', { ref: q.st.ref || '—' })); a.href = pageLink(q.st.transaction_id); li.appendChild(a); }
        ul.appendChild(li);
      });
      box.appendChild(ul);
      var clear = btn(T('q_clear'), 'btn-ghost', function () { S.queue = S.queue.filter(function (q) { return ['queued', 'reading', 'saving', 'hashing', 'checking'].indexOf(q.state) !== -1; }); render(); });
      clear.disabled = S.reading > 0;
      box.appendChild(clear);
      return box;
    }
    function qTone(s) {
      return { done: 'success', restored: 'success', moved_here: 'success', rejected: 'danger', error: 'danger', approved: 'danger', refused: 'danger',
        pending_other: 'warning', move: 'warning', in_batch: 'info', reading: 'info', saving: 'info', queued: 'muted', hashing: 'muted', checking: 'muted', restore: 'info' }[s] || 'muted';
    }
    function qLine(q) {
      if (q.state === 'refused') return T('qr_' + q.why);
      if (q.state === 'rejected') return T('rj_' + q.why);
      if (q.state === 'error') return q.why === 'hash' ? T('err_hash') : errMsg(q.err);
      if (q.state === 'approved') return T('ql_approved');
      if (q.state === 'pending_other') return T('ql_pending_other', { ref: q.st && q.st.ref || T('other_tx') });
      if (q.state === 'move') return T('ql_move', { ref: q.st && q.st.ref || T('other_tx') });
      if (q.state === 'in_batch') return T('ql_in_batch');
      if (q.state === 'restored') return T('ql_restored');
      if (q.state === 'moved_here') return T('ql_moved_here');
      return null;
    }

    /* ---------- the review table ---------- */
    function renderBatch() {
      var b = S.batch, box = el('div', 'appt-batch'), editable = canEdit();
      var c = counts(b), containers = Array.isArray(b.containers) ? b.containers : [], cargo = b.cargo_unit_type || (S.tx && S.tx.cargo_unit_type);
      var head = el('div', 'appt-batch-head');
      head.appendChild(el('h3', 'appt-h3', T('rv_title')));
      head.appendChild(el('span', 'badge badge-sm badge-' + ({ pending: 'warning', partial: 'info', approved: 'success', cancelled: 'danger', moved: 'muted' }[b.status] || 'muted'), T('bst_' + b.status)));
      box.appendChild(head);
      box.appendChild(el('p', 'text-sm text-muted', T('rv_counts', { total: liveCards(b).length, pending: c.pending, failed: c.failed, approved: c.approved, skipped: c.skipped, discarded: c.discarded })));
      if (b.moved_from_transaction_id) box.appendChild(el('p', 'text-sm appt-notice', T('moved_from')));
      if (openBatch(b)) box.appendChild(el('p', 'form-hint', T('autosave_rule')));
      var status = el('p', 'appt-save-status'); status.id = 'appt-save-status'; status.setAttribute('aria-live', 'polite');
      status.textContent = saveStatusText();
      box.appendChild(status);
      if (S.stale) {
        var st = alertBox('warning', T('e_stale'));
        st.appendChild(btn(T('reload'), 'btn-secondary', function () { S.stale = false; S.pending = {}; load(); }));
        box.appendChild(st);
      }
      if (cargo !== 'roro' && !containers.length) box.appendChild(alertBox('warning', T('no_containers')));
      var cards = (Array.isArray(b.cards) ? b.cards : []).filter(function (x) { return x.status !== 'cancelled'; });
      if (!cards.length) { box.appendChild(el('p', 'text-sm text-muted', T('rv_empty'))); }
      else {
        var wrap = el('div', 'table-wrap appt-table-wrap');
        var table = el('table', 'table appt-table');
        var thead = el('thead'), tr = el('tr');
        tr.appendChild(th(T('c_select'), 'appt-col-sel'));
        tr.appendChild(th(T('c_card')));
        MAIN_COLS.forEach(function (k) { if (k === 'container' && cargo === 'roro') return; tr.appendChild(th(T('c_' + k))); });
        tr.appendChild(th(T('c_actions')));
        thead.appendChild(tr); table.appendChild(thead);
        var tbody = el('tbody');
        cards.forEach(function (card) { renderCardRows(tbody, card, containers, cargo, editable); });
        table.appendChild(tbody);
        wrap.appendChild(table);
        box.appendChild(wrap);
      }
      box.appendChild(renderActions(cards, containers, cargo, editable));
      return box;
    }
    function th(text, cls) { var h = el('th', cls || null, text); h.setAttribute('scope', 'col'); return h; }
    function saveStatusText() {
      if (S.saveError) return errMsg(S.saveError);
      if (S.saving || Object.keys(S.pending).length) return T('saving');
      return S.saved ? T('saved') : '';
    }
    function setSaveStatus() { var s = document.getElementById('appt-save-status'); if (s) s.textContent = saveStatusText(); }
    function renderCardRows(tbody, card, containers, cargo, editable) {
      var v = cardView(card), canCard = editable && editableCard(card) && card.status !== 'discarded';
      var tr = el('tr', 'appt-row is-' + card.status);
      tr.setAttribute('data-card', card.id);
      var sel = el('td', 'appt-col-sel');
      if (approvable(card) && editable) {
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!S.selected[card.id]; cb.className = 'appt-sel';
        cb.setAttribute('aria-label', T('sel_aria', { n: card.seq }));
        cb.addEventListener('change', function () { if (cb.checked) S.selected[card.id] = 1; else delete S.selected[card.id]; refreshActions(); });
        sel.appendChild(cb);
      }
      tr.appendChild(sel);
      var cell = el('td', 'appt-col-card'), info = el('div', 'appt-card-info');
      cell.appendChild(info);
      info.appendChild(el('span', 'appt-seq', '#' + card.seq));
      info.appendChild(bdi(card.file_name || ''));
      info.appendChild(el('span', 'badge badge-sm badge-' + ({ pending: 'warning', approved: 'success', skipped: 'muted', failed: 'danger', discarded: 'muted' }[card.status] || 'muted'), T('cst_' + card.status)));
      if (card.status === 'failed' && card.result) {
        var fl = el('span', 'appt-fail', errMsg({ code: card.result.code, field: card.result.detail }));
        fl.setAttribute('role', 'alert');
        info.appendChild(fl);
      }
      if (card.link_voided_at) info.appendChild(el('span', 'appt-sub', T('link_voided')));
      tr.appendChild(cell);
      MAIN_COLS.forEach(function (k) {
        if (k === 'container' && cargo === 'roro') return;
        var td = el('td', 'appt-col-' + k);
        td.appendChild(cellInput(v, k, containers, canCard));
        tr.appendChild(td);
      });
      var acts = el('td', 'appt-col-actions');
      var open = !!S.open[card.id];
      var tg = btn(open ? T('less') : T('more'), 'btn-ghost', function () { S.open[card.id] = !S.open[card.id]; render(); });
      tg.setAttribute('aria-expanded', open ? 'true' : 'false');
      acts.appendChild(tg);
      if (editable && (card.status === 'pending' || card.status === 'failed')) acts.appendChild(btn(T('discard'), 'btn-ghost appt-danger', function () { setStatus(card, 'discarded'); }));
      if (editable && card.status === 'discarded') acts.appendChild(btn(T('restore'), 'btn-ghost', function () { setStatus(card, 'pending'); }));
      tr.appendChild(acts);
      tbody.appendChild(tr);
      // the line of what is missing / the hints (live)
      var mtr = el('tr', 'appt-row-notes'), mtd = el('td');
      mtd.setAttribute('colspan', String(3 + MAIN_COLS.length - (cargo === 'roro' ? 1 : 0)));
      mtd.className = 'appt-notes';
      mtd.setAttribute('data-notes', card.id);
      fillNotes(mtd, v, containers, cargo);
      mtr.appendChild(mtd);
      tbody.appendChild(mtr);
      if (!open) return;
      var dtr = el('tr', 'appt-row-details'), dtd = el('td');
      dtd.setAttribute('colspan', String(3 + MAIN_COLS.length - (cargo === 'roro' ? 1 : 0)));
      var grid = el('div', 'appt-grid');
      DETAIL_KEYS.forEach(function (k) { grid.appendChild(field(T('c_' + k), cellInput(v, k, containers, canCard))); });
      if (S.batch.finance) ['cost_amount', 'sell_amount'].forEach(function (k) { grid.appendChild(field(T('c_' + k), cellInput(v, k, containers, canCard))); });
      dtd.appendChild(grid);
      dtd.appendChild(readingBox(card));
      dtr.appendChild(dtd);
      tbody.appendChild(dtr);
    }
    function field(label, inp) {
      var g = el('div', 'form-group appt-field');
      var id = inp.id || ('appt-f-' + Math.random().toString(36).slice(2));
      inp.id = id;
      var l = el('label', 'form-label', label); l.setAttribute('for', id);
      g.appendChild(l); g.appendChild(inp);
      return g;
    }
    function cellInput(v, key, containers, enabled) {
      var n, val = key === 'container' ? '' : cardValue(v, key), label = T('c_' + key) + ' #' + v.seq;
      if (key === 'container') {
        n = el('select', 'form-control appt-cell appt-cell-ctr');
        var cur = containerOf(v, containers);
        var o0 = el('option', null, T('choose')); o0.value = ''; n.appendChild(o0);
        containers.forEach(function (c) { var o = el('option', null, c.container_no); o.value = c.id + '|' + c.container_no; o.selected = !!cur && cur.id === c.id; n.appendChild(o); });
        if (!cur) o0.selected = true;
        n.setAttribute('data-key', 'container_id');
      } else if (key === 'movement_type' || key === 'party_type') {
        n = el('select', 'form-control appt-cell');
        var list = key === 'movement_type' ? MOVEMENT_TYPES : PARTY_TYPES;
        var e0 = el('option', null, T('choose')); e0.value = ''; n.appendChild(e0);
        list.forEach(function (c) { var o = el('option', null, T((key === 'movement_type' ? 'mt_' : 'pt_') + c)); o.value = c; o.selected = val === c; n.appendChild(o); });
        if (list.indexOf(val) === -1) e0.selected = true;
        n.setAttribute('data-key', key);
      } else {
        n = el('input', 'form-control appt-cell');
        n.type = key === 'appointment_at' ? 'datetime-local' : (key === 'return_deadline' ? 'date' : (key === 'cost_amount' || key === 'sell_amount' ? 'number' : 'text'));
        if (key === 'driver_phone') { n.setAttribute('inputmode', 'tel'); n.dir = 'ltr'; }
        if (['booking_ref', 'operator_ticket_no', 'truck_plate', 'barcode', 'transport_order_no', 'appointment_at', 'return_deadline'].indexOf(key) !== -1) n.dir = 'ltr';
        if (key === 'cost_amount' || key === 'sell_amount') { n.setAttribute('min', '0'); n.setAttribute('step', '0.01'); n.dir = 'ltr'; }
        n.value = key === 'cost_amount' || key === 'sell_amount' ? (v.review && v.review[key] != null ? String(v.review[key]) : '') : val;
        n.setAttribute('maxlength', key === 'notes' ? '1000' : '160');
        n.setAttribute('data-key', key);
      }
      n.setAttribute('aria-label', label);
      n.disabled = !enabled;
      var ev = n.tagName === 'SELECT' ? 'change' : 'input';
      n.addEventListener(ev, function () { onEdit(v.id, n.getAttribute('data-key'), n.value); });
      return n;
    }
    function fillNotes(td, v, containers, cargo) {
      td.textContent = '';
      var miss = cardMissing(v, containers, cargo), hints = cardHints(v, containers, cargo, S.batch);
      if (miss.length && (v.status === 'pending' || v.status === 'failed')) {
        var p = el('p', 'appt-miss');
        p.appendChild(el('span', 'appt-miss-h', T('missing') + ' '));
        miss.forEach(function (m) { p.appendChild(el('span', 'appt-chip is-missing', T('miss_' + m))); });
        td.appendChild(p);
      }
      if (hints.length) {
        var h = el('p', 'appt-hints');
        var sec = cardSection(v);
        hints.forEach(function (x) {
          h.appendChild(el('span', 'appt-chip is-' + (x === 'empty_entry_skip' ? 'info' : 'warn'),
            T('h_' + x, { no: normContainer(cardValue(v, 'container_no')), bl: str(sec.bl_number), decl: str(sec.declaration_number) })));
        });
        td.appendChild(h);
      }
      var ws = (v.reading && Array.isArray(v.reading.warnings) ? v.reading.warnings : []).filter(function (w) { return w && AI_WARNINGS.indexOf(w.code) !== -1 && w.code !== 'wrong_document_type'; });
      if (ws.length) {
        var w = el('p', 'appt-hints');
        ws.forEach(function (x) { w.appendChild(el('span', 'appt-chip is-warn', T('w_' + x.code))); });
        td.appendChild(w);
      }
    }
    function readingBox(card) {
      var a = card.reading && card.reading.appointment || {}, box = el('div', 'appt-reading');
      box.appendChild(el('h4', 'appt-h4', T('rd_title')));
      var dl = el('dl', 'appt-dl');
      function row(k, val, ltr) { if (val == null || val === '') return; var d = el('div'); d.appendChild(el('dt', null, T(k))); var dd = el('dd'); dd.appendChild(bdi(String(val), ltr)); d.appendChild(dd); dl.appendChild(d); }
      row('rd_doc_title', a.document_title);
      row('rd_time', a.appointment_local || a.appointment_at, true);
      row('rd_container', a.container_no, true);
      row('rd_gate', a.gate_instructions);
      row('rd_license', a.driver_license, true);
      row('rd_vehicle', [a.vehicle_ref_id, a.vehicle_serial_id].filter(function (x) { return !blank(x); }).join(' · '), true);
      ['exit', 'entry'].forEach(function (s) {
        var x = a[s];
        if (!x || typeof x !== 'object') return;
        var parts = [x.location, x.bl_number, x.declaration_number, x.container_number, x.cargo_type, x.purpose].filter(function (p) { return !blank(p); });
        if (parts.length) row('rd_' + s, parts.join(' · '));
      });
      if (dl.children.length) box.appendChild(dl);
      else box.appendChild(el('p', 'text-sm text-muted', T('rd_none')));
      box.appendChild(el('p', 'form-hint', T('rd_rule')));
      return box;
    }
    function onEdit(cardId, key, value) {
      var card = (S.batch.cards || []).filter(function (c) { return c.id === cardId; })[0];
      if (!card || !canEdit()) return;
      S.local[cardId] = setReview(S.local[cardId] || card.review || {}, key, value, card);
      S.pending[cardId] = 1; S.saved = false; S.saveError = null;
      var td = root.querySelector('[data-notes="' + cardId + '"]');
      if (td) fillNotes(td, cardView(card), S.batch.containers || [], S.batch.cargo_unit_type || (S.tx && S.tx.cargo_unit_type));
      setSaveStatus();
      refreshActions();
      if (S.timer) clearTimeout(S.timer);
      S.timer = setTimeout(function () { S.timer = null; flush(); }, AUTOSAVE_MS);
    }
    // the autosave: every card edited since the last save, with the draft version
    function flush() {
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
      var ids = Object.keys(S.pending);
      if (!ids.length || !S.batch) return S.saveChain;
      return chain(function () {
        ids = Object.keys(S.pending);
        if (!ids.length) return null;
        var fin = !!S.batch.finance;
        var cards = ids.map(function (id) { return { card_id: id, review: reviewPayload(S.local[id] || {}, fin) }; });
        var sent = {}; ids.forEach(function (id) { sent[id] = JSON.stringify(S.local[id] || {}); });
        S.saving = true; setSaveStatus();
        return API.saveAppointmentDraft(S.route.tx, { batchId: S.batch.id, version: S.batch.version, cards: cards }).then(function (r) {
          r = res0(r); S.saving = false;
          if (r.error) {
            S.saveError = r.error;
            if (r.error.code === 'MRS_APPT_DRAFT_STALE') { S.stale = true; render(); }
            else setSaveStatus();
            return;
          }
          ids.forEach(function (id) { if (JSON.stringify(S.local[id] || {}) === sent[id]) delete S.pending[id]; });
          var keepFocus = Object.keys(S.pending).length > 0;
          S.batch = r.data;
          (r.data.cards || []).forEach(function (c) { if (!S.pending[c.id]) S.local[c.id] = clone(c.review || {}); });
          S.saved = true;
          setSaveStatus();
          if (keepFocus) { S.timer = setTimeout(function () { S.timer = null; flush(); }, AUTOSAVE_MS); }
        });
      });
    }
    function setStatus(card, status) {
      flush().then(function () {
        return chain(function () {
          return API.saveAppointmentDraft(S.route.tx, { batchId: S.batch.id, version: S.batch.version, cards: [{ card_id: card.id, status: status }] }).then(function (r) {
            r = res0(r);
            if (r.error) { if (r.error.code === 'MRS_APPT_DRAFT_STALE') S.stale = true; S.notice = { type: 'danger', text: errMsg(r.error) }; render(); return; }
            delete S.selected[card.id];
            setBatch(r.data); S.notice = null; render();
          });
        });
      });
    }

    /* ---------- approve / cancel / move ---------- */
    // the action box is refilled in place on every edit (the review table keeps its focus)
    var actionsHost = null;
    function refreshActions() {
      if (!actionsHost || !S.batch) return;
      var b = S.batch, cards = (b.cards || []).filter(function (x) { return x.status !== 'cancelled'; });
      fillActions(actionsHost, cards, b.containers || [], b.cargo_unit_type || (S.tx && S.tx.cargo_unit_type), canEdit());
    }
    function renderActions(cards, containers, cargo, editable) {
      var host = el('div', 'appt-actions-host');
      actionsHost = host;
      fillActions(host, cards, containers, cargo, editable);
      return host;
    }
    function fillActions(host, cards, containers, cargo, editable) {
      host.textContent = '';
      var box = el('div', 'appt-actions-box');
      host.appendChild(box);
      if (!openBatch(S.batch)) {
        box.appendChild(el('p', 'text-sm text-muted', T('closed_' + S.batch.status)));
        return box;
      }
      if (!editable) { if (!S.writer || S.batch.can_edit === false) box.appendChild(el('p', 'text-sm text-muted', T('read_only_role'))); return box; }
      var views = cards.map(cardView);
      var all = approvePlan(views, containers, cargo, S.batch);
      var wait = S.reading > 0;
      var selIds = Object.keys(S.selected).filter(function (id) { return views.some(function (c) { return c.id === id && approvable(c); }); });
      var bar = el('div', 'appt-actions');
      var a1 = btn(T('approve_all', { n: all.total }), 'btn-primary', function () { approve(null); });
      a1.id = 'appt-approve-all'; a1.disabled = !all.total || wait;
      bar.appendChild(a1);
      var a2 = btn(T('approve_sel', { n: selIds.length }), 'btn-secondary', function () { approve(selIds); });
      a2.id = 'appt-approve-sel'; a2.disabled = !selIds.length || wait;
      bar.appendChild(a2);
      box.appendChild(bar);
      if (wait) box.appendChild(el('p', 'form-hint appt-wait', T('ap_wait_reading')));
      if (S.approveError) { var e = el('p', 'appt-error', errMsg(S.approveError)); e.setAttribute('role', 'alert'); box.appendChild(e); }
      box.appendChild(el('p', 'form-hint', T('approve_rule')));
      // cancel / move: only a draft with nothing approved yet
      if (S.batch.status === 'pending') {
        var danger = el('details', 'appt-more');
        danger.appendChild(el('summary', null, T('more_actions')));
        var mv = el('div', 'appt-inline');
        var ref = el('input', 'form-control appt-inline-input'); ref.type = 'text'; ref.id = 'appt-move-ref'; ref.dir = 'ltr'; ref.setAttribute('maxlength', '40');
        mv.appendChild(field(T('move_ref'), ref));
        mv.appendChild(btn(T('move_btn'), 'btn-secondary', function () { move(ref.value); }));
        mv.appendChild(el('p', 'form-hint', T('move_rule')));
        danger.appendChild(mv);
        var cn = el('div', 'appt-inline');
        var why = el('input', 'form-control appt-inline-input'); why.type = 'text'; why.id = 'appt-cancel-reason'; why.setAttribute('maxlength', '500');
        cn.appendChild(field(T('cancel_reason'), why));
        cn.appendChild(btn(T('cancel_btn'), 'btn-ghost appt-danger', function () { cancel(why.value); }));
        cn.appendChild(el('p', 'form-hint', T('cancel_rule')));
        danger.appendChild(cn);
        box.appendChild(danger);
      } else box.appendChild(el('p', 'form-hint', T('partial_rule')));
      return box;
    }
    function blockApprove(why) {
      S.approveError = { message: T('ap_' + why) };
      refreshActions(); announce(T('ap_' + why));
    }
    function approve(ids) {
      if (S.approving || !S.batch) return;
      if (approveBlock({ reading: S.reading })) { blockApprove('wait_reading'); return; }
      flush().then(function () {
        if (S.stale) return;
        // a failed / unsaved autosave: the server would approve the review stored before it, not what is on screen
        var why = approveBlock(S);
        if (why) { blockApprove(why === 'reading' ? 'wait_reading' : why); return; }
        var b = S.batch, views = (b.cards || []).map(cardView).filter(function (c) { return !ids || ids.indexOf(c.id) !== -1; });
        var plan = approvePlan(views, b.containers || [], b.cargo_unit_type || (S.tx && S.tx.cargo_unit_type), b);
        var lines = [T('cf_movements', { n: plan.movements })];
        if (plan.skipped) lines.push(T('cf_skipped', { n: plan.skipped }));
        if (plan.incomplete) lines.push(T('cf_incomplete', { n: plan.incomplete }));
        if (plan.mismatch) lines.push(T('cf_mismatch', { n: plan.mismatch }));
        lines.push(T('cf_rule'));
        return askConfirm({ title: ids ? T('cf_title_sel', { n: plan.total }) : T('cf_title_all', { n: plan.total }), text: lines.join(' '), okText: T('cf_ok') }).then(function (yes) {
          if (!yes) return;
          if (approveBlock(S)) { blockApprove(approveBlock(S) === 'reading' ? 'wait_reading' : approveBlock(S)); return; }
          S.approving = true; S.approveError = null; S.result = null; render();
          // in the save chain: the version is read after every save of this tab (a card read meanwhile bumps it)
          return chain(function () {
          var bv = S.batch || b;
          S.idem = approveKey(S.idem, bv.version, ids, uuid);
          var o = { version: bv.version, idemKey: S.idem.key };
          if (ids) o.cardIds = ids.slice();
          return API.approveAppointmentDraft(bv.id, o).then(function (r) {
            r = res0(r); S.approving = false;
            if (r.error) {
              S.approveError = r.error;
              if (r.error.code === 'MRS_APPT_DRAFT_STALE') S.stale = true;
              render(); announce(errMsg(r.error)); return;
            }
            S.idem = null; S.selected = {};
            S.result = resultSummary(r.data);
            if (r.data && r.data.batch) setBatch(r.data.batch);
            S.result.readiness = r.data && r.data.readiness || null;
            render();
            announce(T('res_line', S.result));
            toast(T('res_line', S.result), S.result.failed ? 'warning' : 'success');
          }, function (e) { S.approving = false; S.approveError = e; render(); });
          });
        });
      });
    }
    function renderResult() {
      var r = S.result, box = el('div', 'appt-result');
      box.setAttribute('role', 'status');
      box.appendChild(el('h3', 'appt-h3', T('res_title')));
      box.appendChild(el('p', 'appt-res-sum', T('res_line', r)));
      var ul = el('ul', 'appt-res-list');
      r.results.forEach(function (x) {
        var li = el('li', 'appt-res is-' + x.outcome);
        li.appendChild(el('span', 'badge badge-sm badge-' + ({ saved: 'success', already_existed: 'info', skipped: 'muted', failed: 'danger' }[x.outcome]), T('out_' + x.outcome)));
        li.appendChild(el('span', null, ' #' + (x.seq || '') + ' '));
        li.appendChild(bdi(x.file_name || ''));
        if (x.outcome === 'failed') li.appendChild(el('span', 'appt-fail', ' — ' + errMsg({ code: x.code, field: x.detail })));
        if (x.outcome === 'skipped') li.appendChild(el('span', 'adm-sub', ' — ' + T('out_skipped_why')));
        ul.appendChild(li);
      });
      box.appendChild(ul);
      if (r.readiness && r.readiness.billing_gate_open === false) box.appendChild(alertBox('warning', T('res_gate', { n: r.readiness.pending_count || 0 })));
      var a = el('a', 'btn btn-sm btn-secondary', T('res_open_tx')); a.href = txLink(S.route.tx);
      box.appendChild(a);
      return box;
    }
    function cancel(reason) {
      reason = String(reason || '').trim();
      if (!reason) { S.notice = { type: 'danger', text: T('e_reason') }; render(); return; }
      askConfirm({ title: T('cancel_title'), text: T('cancel_text'), okText: T('cancel_ok'), danger: true }).then(function (yes) {
        if (!yes) return;
        S.busy = true; render();
        flush().then(function () { return API.cancelAppointmentDraft(S.batch.id, reason); }).then(function (r) {
          r = res0(r); S.busy = false;
          if (r.error) { S.notice = { type: 'danger', text: errMsg(r.error) }; render(); return; }
          var n = r.data && r.data.released_cards != null ? (Array.isArray(r.data.released_cards) ? r.data.released_cards.length : Number(r.data.released_cards)) : 0;
          S.batch = null; S.local = {}; S.pending = {}; S.selected = {}; S.queue = []; S.result = null;
          S.notice = { type: 'success', text: T('cancel_done', { n: n }) };
          render(); toast(T('cancel_done', { n: n }), 'success');
        });
      });
    }
    function move(ref) {
      ref = String(ref || '').trim();
      if (!ref) { S.notice = { type: 'danger', text: T('e_target_ref') }; render(); return; }
      askConfirm({ title: T('move_title'), text: T('move_text', { ref: ref }), okText: T('move_ok') }).then(function (yes) {
        if (!yes) return;
        S.busy = true; render();
        flush().then(function () { return API.moveAppointmentDraft(S.batch.id, ref, null); }).then(function (r) {
          r = res0(r); S.busy = false;
          if (r.error) { S.notice = { type: 'danger', text: errMsg(r.error) }; render(); return; }
          var t = r.data || {};
          var node = alertBox('success', T('move_done', { ref: t.ref || ref }));
          if (t.transaction_id) {
            var a = el('a', 'appt-q-link', T('open_other', { ref: t.ref || ref })); a.href = pageLink(t.transaction_id); node.appendChild(a);
          }
          S.batch = null; S.local = {}; S.pending = {}; S.selected = {}; S.queue = []; S.result = null;
          S.notice = { node: node };
          render(); toast(T('move_done', { ref: t.ref || ref }), 'success');
        });
      });
    }

    init();
  });
})();
