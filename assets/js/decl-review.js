/* ==========================================================================
   مرسى | MARSA — ocr.html: customs declaration reading + staff review + approval (legacy step 4 UI)
   Contract: docs/online/LEGACY_DECL_AR.md (backend 20261120000100). Plain IIFE, ES5, no library.
   Depends on window.MarsaApi (supa.js), optional window.MarsaShell (app-shell.js), window.MarsaI18n
   (strings 'decl.*', assets/i18n/decl.js), window.MarsaNorm (legacy-norm.js: Umm al-Qura Hijri),
   window.MarsaDocMatch (doc-match.js: B/L token equivalence) and window.MarsaHsPicker (hs-picker.js).

   Deep links (the section stays hidden without one):
     ocr.html#decl-tx=<transaction id>                     upload ONE declaration file for a saved transaction;
                                                           Claude reads it (aiExtract, ai-doc-v3, customs_declaration)
     ocr.html#decl=<extraction id>&tx=<transaction id>     review + approve that reading for the transaction
                                                           (also the link of a step-3 batch's declaration slot)
   * Reading: the same quota / dedupe rules as step 3 — reused:true (the file was read before, no charge) → the
     extraction_id is used and nothing is saved again; otherwise the reading is saved (saveExtraction with ai_detail,
     MRS_EXTRACTION_DUPLICATE → the saved reading of the same file is reused). A file that is not a declaration is
     held back (never saved as one).
   * Review (getDeclarationReview): number, type + the title evidence, Fasah status, Hijri date with the Gregorian
     date recomputed from it (Umm al-Qura; editing the Hijri recomputes), importer, broker, the B/L exactly as read
     + candidates + the RTL flag and the comparison with the transaction B/Ls (token equivalence, MarsaDocMatch);
     a mismatch needs an explicit confirmation; containers with the merge preview (new / already on the transaction /
     on the transaction only; a container of another transaction with the same B/L is refused by the step-2 guard
     at approval and nothing is saved); items with the HS reference picker (a suggestion only).
   * Approve (ops writers; behind a confirm dialog; idempotent per request): approveDeclarationExtraction with the
     version read; the result shows the declaration action, the status move, the B/L result, the containers
     added / updated / unchanged, the items, the HS reference rows learned, the transaction fields filled / kept.
     Nothing is approved automatically: every value read by Claude stays a draft until then.
   * Untrusted values (readings, file names, server rows) only via textContent / value.
   Pure helpers: window.MarsaDeclReview.pure (supabase/tests/legacy-decl-ui-tests.js).
   ========================================================================== */
(function () {
  'use strict';

  /* ==================================================================
     Pure helpers (no DOM)
     ================================================================== */
  var TYPES = ['import', 'export', 'clearance'];
  // the order of app.decl_compare / approve_declaration_extraction (20261120000100)
  var STATUSES = ['draft', 'submitted', 'accepted', 'under_inspection', 'cco_review_done', 'awaiting_duty_payment', 'release_ready', 'released'];
  var FASAH_STAGES = ['accepted', 'cco_review_done', 'awaiting_duty_payment', 'release_ready', 'released'];
  var CONFLICTS = ['bl_mismatch', 'declaration_other_number', 'declaration_no_taken', 'status_backward', 'containers_roro', 'hijri_unverified',
    'shipment_on_other_tx'];
  var MISSING = ['declaration_no', 'declaration_type', 'declaration_date', 'status', 'containers'];
  var TX_FIELDS = ['vessel', 'declaration_notes', 'country', 'declaration_type', 'declaration_date', 'declaration_date_hijri'];
  // the fields of a recorded declaration (same number) that approval replaces by the reviewed value (declaration_replaced)
  var REPLACEABLE = ['declaration_type', 'declaration_date', 'declaration_date_hijri'];
  var WARNINGS = ['status_backward', 'vessel_no_bl'];
  var AI_WARNINGS = ['decl_type_unverified', 'decl_status_unknown', 'hijri_format', 'hijri_unverified', 'decl_date_corrected', 'bl_rtl',
    'decl_no_containers', 'hs_format'];
  var CTR_KEYS = ['container_number', 'seal_number', 'size_type', 'gross_weight'];
  var ITEM_COLS = ['hs_code', 'description', 'quantity', 'unit', 'value', 'origin_country', 'net_weight', 'gross_weight'];
  var ITEM_KEYS = ['hs_code', 'description', 'invoice_description', 'scientific_name', 'quantity', 'unit', 'value', 'origin_country',
    'net_weight', 'gross_weight', 'invoice_number', 'notes'];
  var ITEM_NUM = ['quantity', 'value', 'net_weight', 'gross_weight'];
  var DECL_NO_RE = /^[A-Za-z0-9\/-]{1,30}$/;
  var CTR_RE = /^[A-Z]{4}\d{7}$/;
  var HS_RE = /^\d{2,14}$/;
  var MAX_ITEMS = 500, MAX_CTR = 300;
  var AI_MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };

  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }
  function blank(v) { return v == null || (typeof v === 'string' && !v.replace(/\s+/g, '')); }
  function str(v) { return v == null ? '' : String(v); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  function parseNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = western(v).replace(/[٬,\s]/g, '').replace(/٫/g, '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  function normContainer(v) { return western(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function normHs(v) { return western(v).replace(/[\s.\-]/g, ''); }
  function normDeclNo(v) { return western(v).replace(/\s+/g, '').toUpperCase(); }

  // ocr.html#decl-tx=<tx> → { tx } · #decl=<extraction>&tx=<tx> → { extraction, tx } · else {}
  function parseHash(h) {
    var s = String(h || '').replace(/^#/, ''), m;
    if ((m = /^decl-tx=([0-9a-f-]{36})$/i.exec(s)) && isUuid(m[1])) return { tx: m[1].toLowerCase() };
    if ((m = /^decl=([0-9a-f-]{36})&tx=([0-9a-f-]{36})$/i.exec(s)) && isUuid(m[1]) && isUuid(m[2])) return { extraction: m[1].toLowerCase(), tx: m[2].toLowerCase() };
    return {};
  }
  function uploadLink(txId) { return 'ocr.html#decl-tx=' + encodeURIComponent(String(txId || '')); }
  function reviewLink(extId, txId) { return 'ocr.html#decl=' + encodeURIComponent(String(extId || '')) + '&tx=' + encodeURIComponent(String(txId || '')); }
  function txLink(txId) { return 'admin.html#tx/' + encodeURIComponent(String(txId || '')); }
  // the three-way match of a draft transaction after its declaration approval (ocr-match.js #match-tx, 20261127000100)
  function matchTxLink(txId, extId) {
    var ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return 'ocr.html#match-tx=' + encodeURIComponent(String(txId || '')) + (ok.test(String(extId || '')) ? '&decl=' + encodeURIComponent(String(extId)) : '');
  }
  function batchLink(id) { return 'ocr.html#batch=' + encodeURIComponent(String(id || '')); }

  // the Hijri field → { state: 'empty'|'invalid'|'unsupported'|'nonexistent'|'ok', hijri, greg }
  function hijriState(v, N) {
    N = N || (typeof window !== 'undefined' ? window.MarsaNorm : null);
    if (blank(v)) return { state: 'empty', hijri: '', greg: '' };
    if (!N || typeof N.normalizeHijri !== 'function') return { state: 'unsupported', hijri: str(v).trim(), greg: '' };
    var h = N.normalizeHijri(v);
    if (!h) return { state: 'invalid', hijri: '', greg: '' };
    if (typeof N.hijriSupported === 'function' && !N.hijriSupported()) return { state: 'unsupported', hijri: h, greg: '' };
    var g = typeof N.hijriToGregorian === 'function' ? N.hijriToGregorian(h) : '';
    return g ? { state: 'ok', hijri: h, greg: g } : { state: 'nonexistent', hijri: h, greg: '' };
  }

  // the review draft → the editable form state
  function formFromDraft(d) {
    d = d || {};
    return {
      declaration_no: str(d.declaration_no), declaration_type: TYPES.indexOf(d.declaration_type) !== -1 ? d.declaration_type : '',
      status: STATUSES.indexOf(d.status) !== -1 ? d.status : '',
      declaration_date: /^\d{4}-\d{2}-\d{2}$/.test(str(d.declaration_date)) ? d.declaration_date : '',
      declaration_date_hijri: str(d.declaration_date_hijri), vessel: str(d.vessel), notes: '',
      containers: (Array.isArray(d.containers) ? d.containers : []).map(function (c) {
        return { container_number: str(c && c.container_number), seal_number: str(c && c.seal_number), size_type: str(c && c.size_type),
          gross_weight: c && c.gross_weight != null ? String(c.gross_weight) : '' };
      }),
      items: (Array.isArray(d.items) ? d.items : []).map(function (it) {
        var o = {};
        ITEM_KEYS.forEach(function (k) { o[k] = it && it[k] != null ? String(it[k]) : ''; });
        return o;
      }),
      confirmBl: false
    };
  }

  // the transaction's containers (as of the review) → { onTx: {no: 1} }
  function txContainerSet(cmp) {
    var c = (cmp && cmp.containers) || {}, out = {};
    [].concat(c.matched || [], c.not_on_declaration || []).forEach(function (n) { out[normContainer(n)] = 1; });
    return out;
  }
  // the declaration's containers the server found on another live transaction under the declaration's B/L (review fix)
  function otherTxSet(cmp) {
    var c = (cmp && cmp.containers) || {}, out = {};
    (Array.isArray(c.on_other_tx) ? c.on_other_tx : []).forEach(function (n) { out[normContainer(n)] = 1; });
    return out;
  }
  // the merge preview of the edited list: each row → 'on_tx' (updated / unchanged) | 'new' (added) | 'other_tx' (refused:
  // the same B/L + container on another live transaction) | 'invalid' | 'dup'
  function containerPreview(rows, cmp) {
    var onTx = txContainerSet(cmp), other = otherTxSet(cmp), seen = {}, out = { rows: [], added: 0, onTx: 0, invalid: 0, otherTx: 0, txOnly: [] };
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var n = normContainer(r && r.container_number), st;
      if (!n) st = 'empty';
      else if (!CTR_RE.test(n)) { st = 'invalid'; out.invalid++; }
      else if (seen[n]) st = 'dup';
      // a container on this transaction AND on another live one under the declaration's B/L still blocks (hardBlock)
      else if (other[n]) { seen[n] = 1; st = 'other_tx'; out.otherTx++; }
      else { seen[n] = 1; st = onTx[n] ? 'on_tx' : 'new'; if (st === 'new') out.added++; else out.onTx++; }
      out.rows.push({ number: n, state: st });
    });
    Object.keys(onTx).sort().forEach(function (n) { if (!seen[n]) out.txOnly.push(n); });
    return out;
  }

  // B/L block: the read value as printed + the candidates, each marked when token-equivalent to a transaction B/L
  function blView(draft, cmp, DM) {
    DM = DM || (typeof window !== 'undefined' ? window.MarsaDocMatch : null);
    var b = (cmp && cmp.bl) || {}, txBls = Array.isArray(b.transaction_bls) ? b.transaction_bls : [];
    var raw = draft && draft.bl_number != null ? String(draft.bl_number) : '';
    var cands = [], seen = {};
    [raw].concat(Array.isArray(b.candidates) ? b.candidates : [], Array.isArray(draft && draft.bl_candidates) ? draft.bl_candidates : [])
      .forEach(function (c) { var s = str(c); if (s && !seen[s]) { seen[s] = 1; cands.push(s); } });
    var eq = DM && typeof DM.blEquivalent === 'function' ? DM.blEquivalent : function (x, y) { return str(x).replace(/\s+/g, '').toUpperCase() === str(y).replace(/\s+/g, '').toUpperCase() && !!str(x); };
    var list = cands.map(function (c) {
      var with_ = txBls.filter(function (t) { return eq(t, c); })[0] || null;
      return { value: c, printed: c === raw, matches: with_ };
    });
    var status = b.status || (!cands.length ? 'not_read' : !txBls.length ? 'no_transaction_bl' : list.some(function (x) { return x.matches; }) ? 'match' : 'mismatch');
    return { raw: raw, candidates: list, transactionBls: txBls.slice(), status: status, matchedWith: b.matched_with || null,
      rtl: !!(b.rtl_affected || (draft && draft.bl_rtl_affected)) };
  }

  // what is still missing in the edited form (the server's MRS_REQUIRED checks, in its order)
  function localMissing(f, cargo) {
    f = f || {};
    var out = [];
    if (blank(f.declaration_no)) out.push('declaration_no');
    if (TYPES.indexOf(f.declaration_type) === -1) out.push('declaration_type');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(f.declaration_date))) out.push('declaration_date');
    if (STATUSES.indexOf(f.status) === -1) out.push('status');
    var ctr = (f.containers || []).filter(function (c) { return !blank(c && c.container_number); });
    if (cargo !== 'roro' && !ctr.length) out.push('containers');
    return out;
  }
  // field-level problems of the edited form → [{ field, code, row? }]
  function validateForm(f, cargo, N) {
    f = f || {};
    var bad = [];
    var no = normDeclNo(f.declaration_no);
    if (no && !DECL_NO_RE.test(no)) bad.push({ field: 'declaration_no', code: 'bad_no' });
    if (!blank(f.declaration_date_hijri)) {
      var h = hijriState(f.declaration_date_hijri, N);
      if (h.state === 'invalid') bad.push({ field: 'declaration_date_hijri', code: 'bad_hijri' });
      else if (h.state === 'nonexistent') bad.push({ field: 'declaration_date_hijri', code: 'hijri_nonexistent' });
    }
    if (!blank(f.declaration_date) && !/^\d{4}-\d{2}-\d{2}$/.test(str(f.declaration_date))) bad.push({ field: 'declaration_date', code: 'bad_date' });
    var ctr = (f.containers || []).filter(function (c) { return !blank(c && c.container_number); });
    if (cargo === 'roro' && ctr.length) bad.push({ field: 'containers', code: 'containers_roro' });
    if (ctr.length > MAX_CTR) bad.push({ field: 'containers', code: 'too_many' });
    (f.containers || []).forEach(function (c, i) {
      if (blank(c && c.container_number)) return;
      if (!CTR_RE.test(normContainer(c.container_number))) bad.push({ field: 'container_number', code: 'bad_container', row: i, table: 'containers' });
      var w = parseNum(c.gross_weight);
      if (w !== null && (isNaN(w) || w < 0)) bad.push({ field: 'gross_weight', code: 'bad_number', row: i, table: 'containers' });
    });
    if ((f.items || []).length > MAX_ITEMS) bad.push({ field: 'items', code: 'too_many' });
    (f.items || []).forEach(function (it, i) {
      if (!blank(it && it.hs_code) && !HS_RE.test(normHs(it.hs_code))) bad.push({ field: 'hs_code', code: 'bad_hs', row: i, table: 'items' });
      ITEM_NUM.forEach(function (k) {
        var n = parseNum(it && it[k]);
        if (n !== null && (isNaN(n) || n < 0)) bad.push({ field: k, code: 'bad_number', row: i, table: 'items' });
      });
    });
    return bad;
  }

  // the edited form → the approve_declaration_extraction options (every reviewed key is sent: the staff value wins)
  function buildPayload(f, version, cargo, N) {
    f = f || {};
    var o = { version: version };
    o.declarationNo = blank(f.declaration_no) ? null : normDeclNo(f.declaration_no);
    o.declarationType = TYPES.indexOf(f.declaration_type) !== -1 ? f.declaration_type : null;
    var h = hijriState(f.declaration_date_hijri, N);
    o.declarationDateHijri = h.state === 'empty' ? null : (h.hijri || str(f.declaration_date_hijri).trim());
    // the Gregorian date recomputed from the Hijri wins (Postgres has no Umm al-Qura calendar)
    o.declarationDate = h.state === 'ok' ? h.greg : (/^\d{4}-\d{2}-\d{2}$/.test(str(f.declaration_date)) ? f.declaration_date : null);
    o.status = STATUSES.indexOf(f.status) !== -1 ? f.status : null;
    o.vessel = blank(f.vessel) ? null : String(f.vessel).trim().slice(0, 80);
    if (!blank(f.notes)) o.notes = String(f.notes).trim().slice(0, 1000);
    var seen = {};
    o.containers = cargo === 'roro' ? [] : (f.containers || []).filter(function (c) { return !blank(c && c.container_number); }).map(function (c) {
      var x = { container_number: normContainer(c.container_number) };
      if (!blank(c.seal_number)) x.seal_number = String(c.seal_number).trim().slice(0, 30);
      if (!blank(c.size_type)) x.size_type = String(c.size_type).trim().toUpperCase().slice(0, 10);
      var w = parseNum(c.gross_weight);
      if (w !== null && !isNaN(w)) x.gross_weight = w;
      return x;
    }).filter(function (c) { if (seen[c.container_number]) return false; seen[c.container_number] = 1; return true; });
    o.items = (f.items || []).filter(function (it) { return it && (!blank(it.hs_code) || !blank(it.description)); }).map(function (it) {
      var x = {};
      ITEM_KEYS.forEach(function (k) {
        var v = it[k];
        if (blank(v)) return;
        if (ITEM_NUM.indexOf(k) !== -1) { var n = parseNum(v); if (n !== null && !isNaN(n)) x[k] = n; return; }
        x[k] = k === 'hs_code' ? normHs(v) : String(v).trim();
      });
      return x;
    });
    if (f.confirmBl) o.confirmBlMismatch = true;
    return o;
  }
  // one idempotency key per (version + payload): a retry of the same request replays, an edited request is new
  function approveKey(prev, version, o, gen) {
    var copy = {};
    Object.keys(o || {}).forEach(function (k) { if (k !== 'idemKey') copy[k] = o[k]; });
    var sig = String(version) + '|' + JSON.stringify(copy);
    if (prev && prev.sig === sig) return prev;
    return { sig: sig, key: typeof gen === 'function' ? gen() : null };
  }
  // review fix: what approval will do with the EDITED values (the review's comparison was computed on the values read):
  // o = buildPayload(...) → { action 'add'|'correct'|'conflict', direction 'initial'|'forward'|'same'|'backward'|'unknown',
  // current, status, replaced [REPLACEABLE fields the recorded declaration holds with another value] }
  // (= approve_declaration_extraction: same number → correct, another active number → conflict; a status behind is kept)
  function planOf(o, cmp) {
    o = o || {}; cmp = cmp || {};
    var ex = (cmp.declaration || {}).existing || null;
    var st = STATUSES.indexOf(o.status) !== -1 ? o.status : null;
    var out = { action: 'add', direction: st ? 'initial' : 'unknown', current: ex ? ex.status || null : null, status: st, replaced: [] };
    if (!ex) return out;
    var no = blank(o.declarationNo) ? '' : normDeclNo(o.declarationNo);
    out.action = !no || normDeclNo(ex.declaration_no) === no ? 'correct' : 'conflict';
    if (st) {
      var a = STATUSES.indexOf(st), b = STATUSES.indexOf(ex.status);
      out.direction = ex.status === st ? 'same' : (b !== -1 && a > b ? 'forward' : 'backward');
    }
    if (out.action === 'correct') {
      var exType = TYPES.indexOf(ex.declaration_type_code) !== -1 ? ex.declaration_type_code : (TYPES.indexOf(ex.declaration_type) !== -1 ? ex.declaration_type : null);
      if (!blank(ex.declaration_type) && o.declarationType && exType !== o.declarationType) out.replaced.push('declaration_type');
      if (!blank(ex.declaration_date) && o.declarationDate && str(ex.declaration_date).slice(0, 10) !== o.declarationDate) out.replaced.push('declaration_date');
      if (!blank(ex.declaration_date_hijri) && o.declarationDateHijri && str(ex.declaration_date_hijri) !== o.declarationDateHijri) out.replaced.push('declaration_date_hijri');
    }
    return out;
  }
  // the comparison notices for the EDITED values: the server's notices that depend on the number / status / Hijri /
  // containers read are recomputed (number conflict, status behind) or dropped when the edit removed their cause
  function effectiveConflicts(o, cmp, draft, N) {
    o = o || {}; cmp = cmp || {};
    var plan = planOf(o, cmp);
    var sameNo = normDeclNo(o.declarationNo || '') === normDeclNo((draft && draft.declaration_no) || '');
    var other = otherTxSet(cmp), hasOther = (o.containers || []).some(function (c) { return other[normContainer(c && c.container_number)]; });
    var hs = hijriState(o.declarationDateHijri, N);
    var out = (Array.isArray(cmp.conflicts) ? cmp.conflicts : []).filter(function (c) {
      if (!c || !c.code || c.code === 'declaration_other_number' || c.code === 'status_backward') return false;
      if (c.code === 'declaration_no_taken') return sameNo;
      if (c.code === 'shipment_on_other_tx') return hasOther;
      if (c.code === 'hijri_unverified') return hs.state !== 'ok';
      return true;
    }).map(function (c) { return { code: c.code, blocking: !!c.blocking, confirmable: !!c.confirmable }; });
    if (plan.action === 'conflict') out.unshift({ code: 'declaration_other_number', blocking: true, confirmable: false });
    if (plan.direction === 'backward') out.push({ code: 'status_backward', blocking: false, confirmable: false });
    return out;
  }
  // a blocking notice that no confirmation lifts (approval is refused by the server)
  function hardBlock(confs) { return (confs || []).some(function (c) { return c.blocking && !c.confirmable; }); }
  // the approve result → numbers / lists for the summary
  function resultSummary(r) {
    r = r || {};
    var c = r.containers || {}, b = r.bl || {}, hs = r.hs_reference || {};
    function arr(v) { return Array.isArray(v) ? v.slice() : []; }
    return {
      ref: r.ref || '', declarationNo: r.declaration && r.declaration.declaration_no || '', action: r.declaration_action || '',
      statusAction: r.status_action || '', bl: b.status || '', blWith: b.matched_with || null,
      added: arr(c.added), updated: arr(c.updated), unchanged: arr(c.unchanged), items: Number(r.items) || 0,
      hsSaved: Number(hs.saved) || 0, filled: arr(r.tx_filled), kept: arr(r.tx_kept), replaced: arr(r.declaration_replaced), warnings: arr(r.warnings),
      replayed: !!(r.replayed || r.replayedEarlier), batchId: r.batch_id || null, daftra: r.daftra_hook || 'deferred'
    };
  }
  // an aiExtract answer → is it a customs declaration? (detected type / detected documents; none = trust the request).
  // Review fix (legacy assertExpectedDocumentType_): 'other' is the wrong file too — the server refuses it (MRS_MATCH_DOC_KIND).
  function readingKindOk(res) {
    res = res || {};
    var det = res.detected_type || (res.ai_detail && res.ai_detail.detected_type) || null;
    var docs = res.ai_detail && Array.isArray(res.ai_detail.detected_documents) ? res.ai_detail.detected_documents : [];
    if (docs.indexOf('customs_declaration') !== -1) return { ok: true, detected: 'customs_declaration' };
    if (!det || det === 'customs_declaration' || det === 'auto') return { ok: true, detected: det || null };
    return { ok: false, detected: det };
  }
  // the saved reading (document_extractions insert, ⊆ supa.js EXT_INSERT) of a fresh v3 declaration reading
  function extractionRow(o) {
    var res = o.res || {}, file = o.file || {}, maxPage = 0;
    (res.fields || []).forEach(function (f) { if (f && f.page > maxPage) maxPage = f.page; });
    var row = {
      doc_type: 'customs_declaration', source_name: String(file.name || 'customs_declaration').slice(0, 255),
      source_sha256: o.sha256 || res.source_sha256 || '', source_mime: o.mime || null, source_size: file.size != null ? file.size : null,
      source_pages: maxPage ? Math.min(Math.max(maxPage, 1), 200) : null, engine: res.model || 'claude-opus-5-5', languages: 'auto',
      mean_confidence: res.mean_confidence == null ? null : Math.min(100, Math.max(0, Number(res.mean_confidence))),
      raw_text: String(res.raw_text || '').slice(0, 200000),
      extracted_fields: res.extracted_fields && typeof res.extracted_fields === 'object' ? res.extracted_fields : {},
      qr_payload: null, line_items: Array.isArray(res.line_items) ? res.line_items.slice(0, 500) : [], ai_usage_id: res.usage_id
    };
    if (res.ai_detail && typeof res.ai_detail === 'object') row.ai_detail = res.ai_detail;
    if (o.orgId) row.org_id = o.orgId;
    if (o.transactionId) row.transaction_id = o.transactionId;
    return row;
  }
  function mediaType(f) {
    var t = String(f && f.type || '').toLowerCase();
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].indexOf(t) !== -1) return t;
    var n = String(f && f.name || ''), i = n.lastIndexOf('.');
    return i > 0 ? AI_MEDIA[n.slice(i + 1).toLowerCase()] || null : null;
  }
  // 5 MB for an image, 10 MB for a PDF (supa.js AI_MAX_IMAGE_BYTES / AI_MAX_BYTES)
  function fileProblem(f) {
    var m = mediaType(f);
    if (!m) return 'unsupported';
    var max = m === 'application/pdf' ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (Number(f.size) > max) return 'too_large';
    return null;
  }
  // a known error code + detail → the decl dictionary key (else the API message)
  var ERR_KEYS = {
    'MRS_INVALID:declaration_no_taken': 'e_no_taken', 'MRS_INVALID:containers_roro': 'e_containers_roro',
    'MRS_INVALID:container_number': 'e_container_number', 'MRS_INVALID:hs_code': 'e_hs_code', 'MRS_INVALID:declaration_type': 'e_type',
    'MRS_INVALID:status': 'e_status', 'MRS_INVALID:declaration_date_hijri': 'e_hijri', 'MRS_INVALID:declaration_date': 'e_date',
    'MRS_REQUIRED:declaration_no': 'e_req_no', 'MRS_REQUIRED:declaration_type': 'e_req_type', 'MRS_REQUIRED:declaration_date': 'e_req_date',
    'MRS_REQUIRED:status': 'e_req_status', 'MRS_REQUIRED:containers': 'e_req_containers', 'MRS_TOO_LONG:declaration_no': 'e_bad_no',
    'MRS_FORBIDDEN:role': 'e_role', 'MRS_MATCH_DOC_KIND:customs_declaration': 'e_kind', 'MRS_MATCH_DOC_VOIDED:extraction': 'e_voided',
    'MRS_NOT_FOUND:extraction': 'e_no_extraction', 'MRS_NOT_FOUND:transaction': 'e_no_tx', 'MRS_INVALID:transaction_id': 'e_other_tx'
  };
  function errKey(e) {
    if (!e || !e.code) return null;
    var k = e.code + ':' + (e.field || e.detail || '');
    return Object.prototype.hasOwnProperty.call(ERR_KEYS, k) ? ERR_KEYS[k] : null;
  }

  var PURE = {
    TYPES: TYPES, STATUSES: STATUSES, FASAH_STAGES: FASAH_STAGES, CONFLICTS: CONFLICTS, MISSING: MISSING, TX_FIELDS: TX_FIELDS, REPLACEABLE: REPLACEABLE,
    WARNINGS: WARNINGS, AI_WARNINGS: AI_WARNINGS, CTR_KEYS: CTR_KEYS, ITEM_COLS: ITEM_COLS, ITEM_KEYS: ITEM_KEYS, ERR_KEYS: ERR_KEYS,
    isUuid: isUuid, parseNum: parseNum, normContainer: normContainer, normHs: normHs, normDeclNo: normDeclNo, parseHash: parseHash,
    uploadLink: uploadLink, reviewLink: reviewLink, txLink: txLink, matchTxLink: matchTxLink, batchLink: batchLink, hijriState: hijriState,
    formFromDraft: formFromDraft, txContainerSet: txContainerSet, containerPreview: containerPreview, blView: blView,
    localMissing: localMissing, validateForm: validateForm, buildPayload: buildPayload, approveKey: approveKey, planOf: planOf,
    effectiveConflicts: effectiveConflicts, hardBlock: hardBlock, otherTxSet: otherTxSet,
    resultSummary: resultSummary, readingKindOk: readingKindOk, extractionRow: extractionRow, mediaType: mediaType,
    fileProblem: fileProblem, errKey: errKey
  };
  window.MarsaDeclReview = { VERSION: 'decl-ui-1', pure: PURE };

  /* ==================================================================
     Page UI (ocr.html only: #decl-section)
     ================================================================== */
  function ready(fn) {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var section = document.getElementById('decl-section');
    var root = document.getElementById('decl-root');
    if (!section || !root) return;
    var API = window.MarsaApi || null;
    var Shell = window.MarsaShell || null;
    var I18N = window.MarsaI18n || null;
    var M = window.Marsa || {};
    var toast = Shell && typeof Shell.toast === 'function' ? function (m, t) { Shell.toast(m, t); }
      : (M.toast || function (m) { try { console.log(m); } catch (e) { /* noop */ } });

    function T(key, vars) {
      var k = 'decl.' + key;
      return I18N && typeof I18N.t === 'function' && (!I18N.has || I18N.has(k)) ? I18N.t(k, vars) : key;
    }
    function lang() { return I18N && typeof I18N.lang === 'function' && I18N.lang() === 'en' ? 'en' : 'ar'; }
    function has(fn) { return !!(API && typeof API[fn] === 'function'); }
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
      var a = el('div', 'alert alert-' + type + ' decl-alert');
      a.setAttribute('role', type === 'danger' ? 'alert' : 'status');
      a.appendChild(el('span', null, text));
      return a;
    }
    function errMsg(e) {
      var k = errKey(e);
      if (k) return T(k);
      if (e && e.raw === undefined && typeof e.message === 'string' && e.message && !/^MRS_[A-Z_]+$/.test(e.message)) return e.message;
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
    function announce(msg) { var s = document.getElementById('decl-live'); if (s) s.textContent = msg; }
    function askConfirm(o) {
      if (Shell && typeof Shell.confirm === 'function') {
        if (o.body && o.body.nodeType) { var c = {}; for (var k in o) if (k !== 'text') c[k] = o[k]; return Shell.confirm(c); }
        return Shell.confirm(o);
      }
      return Promise.resolve(window.confirm((o.title ? o.title + '\n\n' : '') + (o.text || '')));
    }
    function uuid() { return API && API.util && API.util.uuid ? API.util.uuid() : null; }
    function stLabel(s) { return s ? T('st_' + s) : T('none'); }
    function typeLabel(s) { return s ? T('type_' + s) : T('none'); }
    function fileB64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
        fr.onerror = function () { reject(new Error('read')); };
        fr.readAsDataURL(file);
      });
    }
    function sha256(file) {
      if (API && API.util && API.util.sha256Hex) return API.util.sha256Hex(file).catch(function () { return ''; });
      if (!window.crypto || !crypto.subtle || !file.arrayBuffer) return Promise.resolve('');
      return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).catch(function () { return ''; });
    }

    /* ---------------------------------------------------------------
       State + access gate
       --------------------------------------------------------------- */
    var ONLINE = !!(API && API.isOnline && API.isOnline());
    var S = {
      staff: false, writer: false, ai: false, remaining: null, orgId: null, route: {}, tx: null, txError: null,
      file: null, reading: false, readError: null, review: null, reviewError: null, form: null, loading: false,
      approving: false, approveError: null, idem: null, result: null, picker: null, seq: 0, dirty: false, notice: null
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
      if (!ONLINE || !API || !has('getDeclarationReview') || !has('approveDeclarationExtraction')) { section.hidden = true; return; }
      var shellReady = Shell && Shell.ready && typeof Shell.ready.then === 'function' ? Shell.ready : Promise.resolve(null);
      shellReady.then(function () { return API.getSession(); }).then(function (s) {
        if (!s || s.error || !s.data) return false;
        return API.isStaff().then(function (r) { return !r.error && !!r.data; });
      }).then(function (staff) {
        S.staff = !!staff;
        if (!S.staff) { section.hidden = true; return null; }
        var R = Shell && Shell.R && Shell.R.opsWriter;
        S.writer = Shell && typeof Shell.can === 'function' && R ? !!Shell.can(R) : true;
        return orgP().then(function (oid) {
          return has('aiAccess') ? API.aiAccess(oid || undefined).then(function (r) {
            S.ai = !!(r && !r.error && r.data && r.data.can_use === true);
            S.remaining = S.ai && r.data.daily_remaining != null ? Number(r.data.daily_remaining) : null;
          }, function () { S.ai = false; }) : null;
        });
      }).then(function () { if (S.staff) route(); }).catch(function () { section.hidden = true; });
    }
    window.addEventListener('hashchange', function () { if (S.staff) route(); });
    window.addEventListener('beforeunload', function (e) {
      if (!S.dirty || !S.review || S.result || S.review.approval) return;
      e.preventDefault(); e.returnValue = '';
    });
    window.addEventListener('marsa:orgchange', function () { S.orgId = null; S.tx = null; S.review = null; S.form = null; if (S.staff) route(); });

    function route() {
      var h = parseHash(location.hash);
      S.route = h;
      if (!h.tx) { section.hidden = true; return; }
      section.hidden = false;
      S.result = null; S.approveError = null; S.readError = null; S.idem = null; S.notice = null;
      if (h.extraction) loadReview(h.extraction, h.tx);
      else { S.review = null; S.form = null; loadTx(h.tx).then(render); render(); }
      var t = document.getElementById('decl-title');
      if (t) { try { t.focus({ preventScroll: false }); } catch (e) { t.focus(); } }
    }
    function loadTx(txId) {
      if (S.tx && S.tx.id === txId) return Promise.resolve(S.tx);
      S.txError = null;
      if (!has('getTransaction')) return Promise.resolve(null);
      return API.getTransaction(txId).then(function (r) {
        if (r && !r.error && r.data) { S.tx = r.data; return r.data; }
        S.txError = r && r.error ? r.error : { code: 'MRS_NOT_FOUND', field: 'transaction' };
        return null;
      }, function (e) { S.txError = e; return null; });
    }
    // o.keepForm (the reload after MRS_DECL_STALE): the staff's edits of the same reading are kept over the fresh review
    function loadReview(extId, txId, o) {
      o = o || {};
      var my = ++S.seq;
      var keep = o.keepForm && S.form && S.review && S.review.extraction_id === extId ? S.form : null;
      // review fix: a reload clears the previous approval error (the stale notice) and its idempotency key
      S.loading = true; S.reviewError = null; S.approveError = null; S.idem = null; S.notice = null;
      render();
      return Promise.all([API.getDeclarationReview(extId, txId), loadTx(txId)]).then(function (rs) {
        if (my !== S.seq) return;
        var r = rs[0];
        S.loading = false;
        if (!r || r.error || !r.data) { S.review = null; S.form = null; S.reviewError = (r && r.error) || { message: T('err_generic') }; render(); return; }
        S.review = r.data;
        if (keep && !r.data.approval) { S.form = keep; S.notice = T('stale_kept'); }
        else { S.form = formFromDraft(r.data.draft); S.dirty = false; }
        render();
      }, function (e) { if (my === S.seq) { S.loading = false; S.reviewError = e; render(); } });
    }

    /* ---------------------------------------------------------------
       Render
       --------------------------------------------------------------- */
    function render() {
      root.textContent = '';
      if (S.picker) { S.picker.close(); S.picker = null; }
      root.appendChild(renderHead());
      if (S.route.extraction) {
        if (S.loading) { root.appendChild(el('p', 'text-sm text-muted', T('loading'))); return; }
        if (S.reviewError) {
          root.appendChild(alertBox('danger', errMsg(S.reviewError)));
          root.appendChild(btn(T('reload'), 'btn-secondary', function () { loadReview(S.route.extraction, S.route.tx); }));
          // a reading that is not a declaration can never be approved: let ops staff void it from here
          if (S.reviewError.code === 'MRS_MATCH_DOC_KIND' && S.writer && API && typeof API.voidExtraction === 'function') {
            root.appendChild(btn(T('void_reading'), 'btn-ghost decl-danger', function () {
              var reason = window.prompt(T('void_reason_prompt'), '');
              if (reason == null) return;
              if (!String(reason).trim()) { window.alert(T('void_reason_needed')); return; }
              API.voidExtraction(S.route.extraction, String(reason).trim()).then(function (r) {
                if (r && r.error) { window.alert(errMsg(r.error)); return; }
                if (S.route.tx) window.location.href = 'admin.html#tx/' + encodeURIComponent(S.route.tx);
                else loadReview(S.route.extraction, S.route.tx);
              });
            }));
          }
          return;
        }
        if (S.result) { root.appendChild(renderResult()); return; }
        if (S.review) root.appendChild(renderReview());
        return;
      }
      root.appendChild(renderUpload());
    }
    function renderHead() {
      var box = el('div', 'decl-head');
      var dl = el('dl', 'decl-meta');
      function row(k, v) { if (v == null || v === '') return; var d = el('div'); d.appendChild(el('dt', null, k)); var dd = el('dd'); dd.appendChild(typeof v === 'string' ? bdi(v) : v); d.appendChild(dd); dl.appendChild(d); }
      var tx = S.tx, rv = S.review;
      var ref = (rv && rv.ref) || (tx && tx.ref) || '';
      if (S.route.tx) {
        var a = el('a', null, ref || T('tx_open'));
        a.href = txLink(S.route.tx);
        row(T('m_tx'), a);
      }
      if (tx && tx.bl_number) row(T('m_tx_bl'), bdi(tx.bl_number, true));
      if (tx && tx.clients && tx.clients.name_ar) row(T('m_client'), tx.clients.name_ar);
      if (rv && rv.batch_id) { var b = el('a', null, T('m_batch_link')); b.href = batchLink(rv.batch_id); row(T('m_batch'), b); }
      if (rv && rv.prompt_version) row(T('m_prompt'), bdi(rv.prompt_version, true));
      if (dl.children.length) box.appendChild(dl);
      if (S.txError && !rv) box.appendChild(alertBox('danger', errMsg(S.txError)));
      if (tx && tx.cancelled_at) box.appendChild(alertBox('warning', T('tx_cancelled')));
      if (!S.writer) box.appendChild(alertBox('info', T('read_only_role')));
      return box;
    }

    /* ---------- upload + read ---------- */
    function renderUpload() {
      var box = el('div', 'ocr-block decl-upload');
      box.appendChild(el('h3', 'decl-h3', T('up_title')));
      box.appendChild(el('p', 'text-sm text-muted', T('up_lead')));
      if (!S.ai) box.appendChild(alertBox('warning', T('ai_off')));
      else if (S.remaining != null) box.appendChild(el('p', 'text-sm text-muted', T('ai_remaining', { n: S.remaining })));
      var canRead = S.ai && S.writer && !!S.tx && !(S.tx && S.tx.cancelled_at);
      var drop = el('label', 'dropzone decl-drop');
      var inp = el('input'); inp.type = 'file'; inp.id = 'decl-file';
      inp.accept = '.jpg,.jpeg,.png,.webp,.gif,.pdf,image/jpeg,image/png,image/webp,image/gif,application/pdf';
      inp.className = 'decl-file'; inp.disabled = !canRead || S.reading;
      inp.setAttribute('aria-label', T('up_file_aria'));
      inp.addEventListener('change', function () { pickFile(this.files && this.files[0]); this.value = ''; });
      drop.appendChild(inp);
      drop.appendChild(el('span', 'dropzone-title', T('up_drop')));
      drop.appendChild(el('span', 'dropzone-sub', T('formats')));
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-dragover'); }); });
      ['dragleave', 'dragend'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('is-dragover'); }); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); drop.classList.remove('is-dragover');
        if (canRead && e.dataTransfer && e.dataTransfer.files) pickFile(e.dataTransfer.files[0]);
      });
      box.appendChild(drop);
      if (S.file) {
        var f = el('p', 'decl-file-name');
        f.appendChild(el('span', null, T('up_file') + ' '));
        f.appendChild(bdi(S.file.name || ''));
        box.appendChild(f);
      }
      if (S.readError) box.appendChild(errorLine(S.readError));
      var bar = el('div', 'decl-actions');
      var rb = btn(S.reading ? T('reading') : T('read'), 'btn-primary', readFile);
      rb.id = 'decl-read-btn';
      rb.disabled = !canRead || !S.file || S.reading;
      bar.appendChild(rb);
      bar.appendChild(el('span', 'text-sm text-muted', T('dedupe_hint')));
      box.appendChild(bar);
      box.appendChild(el('p', 'form-hint', T('draft_rule')));
      return box;
    }
    function errorLine(e) {
      var p = el('p', 'decl-error', typeof e === 'string' ? e : errMsg(e));
      p.setAttribute('role', 'alert');
      return p;
    }
    function pickFile(f) {
      if (!f) return;
      var why = fileProblem(f);
      S.readError = why ? T(why === 'too_large' ? 'err_too_large' : 'err_unsupported') : null;
      S.file = why ? null : f;
      render();
    }
    function readFile() {
      var f = S.file, txId = S.route.tx;
      if (!f || !txId || S.reading) return;
      S.reading = true; S.readError = null; render();
      announce(T('reading'));
      var mime = mediaType(f), sha = '';
      sha256(f).then(function (h) {
        sha = h;
        return fileB64(f);
      }).then(function (b64) {
        return orgP().then(function (oid) {
          return API.aiExtract({ orgId: oid || undefined, docType: 'customs_declaration', file: { media_type: mime, data_b64: b64 },
            transactionId: txId, lang: lang(), promptVersion: 'ai-doc-v3' });
        });
      }).then(function (r) {
        if (!r || r.error || !r.data) throw (r && r.error) || new Error(T('err_generic'));
        var res = r.data;
        if (!res.reused && S.remaining != null) S.remaining = Math.max(0, S.remaining - 1);
        var kind = readingKindOk(res);
        if (!kind.ok) { var e = new Error(T('wrong_kind', { kind: T('kind_' + kind.detected) === 'kind_' + kind.detected ? String(kind.detected) : T('kind_' + kind.detected) })); throw e; }
        if (res.reused && isUuid(res.extraction_id)) return res.extraction_id;
        var row = extractionRow({ res: res, file: f, sha256: sha, mime: mime, orgId: S.orgId, transactionId: txId });
        return API.saveExtraction(row).then(function (s) {
          if (!s.error && s.data) return s.data.id;
          if (!s.error || s.error.code !== 'MRS_EXTRACTION_DUPLICATE' || !has('findExtractionBySource')) throw s.error || new Error(T('err_generic'));
          return API.findExtractionBySource({ orgId: S.orgId || undefined, sha256: row.source_sha256, transactionId: txId }).then(function (x) {
            if (x.error || !x.data) throw s.error;
            if (x.data.doc_type !== 'customs_declaration') throw new Error(T('wrong_kind', { kind: x.data.doc_type }));
            return x.data.id;
          });
        });
      }).then(function (extId) {
        S.reading = false; S.file = null;
        announce(T('read_done'));
        var want = '#decl=' + extId + '&tx=' + txId;
        if (location.hash === want) route(); else location.hash = want;
      }).catch(function (e) { S.reading = false; S.readError = e; render(); announce(errMsg(e)); });
    }

    /* ---------- review ---------- */
    function field(label, inp, o) {
      o = o || {};
      var g = el('div', 'form-group decl-field' + (o.wide ? ' is-wide' : ''));
      if (o.name) g.setAttribute('data-field', o.name);
      var id = 'decl-f-' + (o.name || Math.random().toString(36).slice(2));
      var l = el('label', 'form-label', label);
      l.setAttribute('for', id);
      inp.id = id;
      g.appendChild(l);
      g.appendChild(inp);
      if (o.hint) { var h = el('span', 'form-hint', o.hint); h.id = id + '-hint'; inp.setAttribute('aria-describedby', h.id); g.appendChild(h); }
      var err = el('span', 'decl-field-error'); err.hidden = true; err.setAttribute('role', 'alert');
      g.appendChild(err);
      return g;
    }
    function textInput(key, o) {
      o = o || {};
      var inp = el('input', 'form-control');
      inp.type = o.type || 'text';
      inp.value = S.form[key] == null ? '' : S.form[key];
      if (o.ltr) inp.dir = 'ltr';
      if (o.max) inp.maxLength = o.max;
      inp.disabled = !editable();
      inp.addEventListener('input', function () { S.form[key] = inp.value; S.dirty = true; if (o.onInput) o.onInput(inp); refreshChecks(); });
      return inp;
    }
    function selectInput(key, codes, labelFn) {
      var sel = el('select', 'form-control');
      var o0 = el('option', null, T('choose')); o0.value = ''; sel.appendChild(o0);
      codes.forEach(function (c) { var o = el('option', null, labelFn(c)); o.value = c; o.selected = S.form[key] === c; sel.appendChild(o); });
      if (!S.form[key]) o0.selected = true;
      sel.disabled = !editable();
      sel.addEventListener('change', function () { S.form[key] = sel.value; S.dirty = true; refreshChecks(); });
      return sel;
    }
    function editable() { return S.writer && !S.approving && S.review && !S.review.approval && !(S.tx && S.tx.cancelled_at); }
    function renderReview() {
      var rv = S.review, d = rv.draft || {}, cmp = rv.comparison || {};
      var wrap = el('div', 'decl-review');
      if (rv.approval) {
        var a = rv.approval;
        var box = alertBox('success', T('already_approved', { at: fmtDate(a.approved_at) }));
        var ln = el('a', null, T('open_tx')); ln.href = txLink(rv.transaction_id);
        box.appendChild(el('span', null, ' ')); box.appendChild(ln);
        wrap.appendChild(box);
      } else {
        wrap.appendChild(alertBox('info', T('draft_rule')));
      }
      // 1. declaration
      var s1 = section_(T('sec_decl'));
      var g = el('div', 'decl-grid');
      g.appendChild(field(T('f_no'), textInput('declaration_no', { ltr: true, max: 30 }), { name: 'declaration_no' }));
      var typeSel = selectInput('declaration_type', TYPES, typeLabel);
      g.appendChild(field(T('f_type'), typeSel, { name: 'declaration_type', hint: d.type_evidence ? T('type_evidence', { e: d.type_evidence }) : T('type_no_evidence') }));
      var stSel = selectInput('status', STATUSES, stLabel);
      g.appendChild(field(T('f_status'), stSel, { name: 'status', hint: d.status_raw ? T('status_raw', { s: d.status_raw }) : null }));
      // Hijri → Gregorian (Umm al-Qura): the Gregorian field follows the Hijri one
      var gInp = textInput('declaration_date', { type: 'date', ltr: true });
      var hHint = el('span', 'form-hint decl-hijri-state');
      var hInp = textInput('declaration_date_hijri', { ltr: true, max: 20, onInput: function () { syncHijri(gInp, hHint); } });
      hInp.placeholder = '1447/03/15';
      var hf = field(T('f_hijri'), hInp, { name: 'declaration_date_hijri', hint: T('hijri_hint') });
      hf.appendChild(hHint);
      g.appendChild(hf);
      g.appendChild(field(T('f_date'), gInp, { name: 'declaration_date', hint: T('date_hint') }));
      g.appendChild(field(T('f_vessel'), textInput('vessel', { max: 80 }), { name: 'vessel', hint: T('vessel_hint') }));
      s1.appendChild(g);
      syncHijri(gInp, hHint);
      var facts = el('dl', 'adm-dl decl-dl');
      [['f_importer', d.importer_name_ar], ['f_broker', d.broker_name], ['f_consignee', d.consignee_name], ['f_origin', d.country_of_origin],
        ['f_pol', d.port_of_loading], ['f_pod', d.port_of_discharge], ['f_invoice_no', d.invoice_number, 1],
        ['f_invoice_value', d.invoice_value != null ? String(d.invoice_value) + (d.currency ? ' ' + d.currency : '') : null, 1],
        ['f_local_value', d.local_value != null ? String(d.local_value) : null, 1], ['f_payment', d.payment_method],
        ['f_packages', d.packages_count != null ? String(d.packages_count) + (d.package_type ? ' ' + d.package_type : '') : null, 1],
        ['f_gross', d.gross_weight != null ? String(d.gross_weight) : null, 1], ['f_net', d.net_weight != null ? String(d.net_weight) : null, 1],
        ['f_goods', d.goods_description], ['f_date_printed', d.date_printed, 1]].forEach(function (r) {
        if (r[1] == null || r[1] === '') return;
        var x = el('div'); x.appendChild(el('dt', null, T(r[0]))); var dd = el('dd'); dd.appendChild(bdi(String(r[1]), !!r[2])); x.appendChild(dd); facts.appendChild(x);
      });
      if (facts.children.length) { s1.appendChild(el('h4', 'decl-h4', T('sec_read_facts'))); s1.appendChild(facts); }
      // review fix: what approval will do follows the EDITED number / status / dates (refreshChecks → paintPlan)
      var planBox = el('div', 'decl-plan'); planBox.id = 'decl-plan';
      planBox.setAttribute('aria-live', 'polite');
      s1.appendChild(planBox);
      wrap.appendChild(s1);
      // 2. B/L
      wrap.appendChild(renderBl(d, cmp));
      // 3. containers
      wrap.appendChild(renderContainers());
      // 4. items
      wrap.appendChild(renderItems());
      // 5. checks + approve
      var chk = el('div', 'decl-checks'); chk.id = 'decl-checks';
      wrap.appendChild(chk);
      wrap.appendChild(renderApprove());
      setTimeout(refreshChecks, 0);
      return wrap;
    }
    function section_(title) {
      var s = el('section', 'ocr-block decl-sec');
      s.appendChild(el('h3', 'decl-h3', title));
      return s;
    }
    function syncHijri(gInp, hint) {
      var h = hijriState(S.form.declaration_date_hijri);
      hint.className = 'form-hint decl-hijri-state';
      if (h.state === 'ok') {
        // the Gregorian date is recomputed from the Hijri (Umm al-Qura) and follows it
        S.form.declaration_date = h.greg; gInp.value = h.greg;
        gInp.readOnly = true;
        hint.textContent = T('hijri_ok', { g: h.greg });
      } else {
        gInp.readOnly = false;
        if (h.state === 'empty') hint.textContent = '';
        else if (h.state === 'unsupported') { hint.textContent = T('hijri_unsupported'); hint.className += ' decl-warn'; }
        else if (h.state === 'nonexistent') { hint.textContent = T('hijri_nonexistent'); hint.className += ' decl-warn'; }
        else { hint.textContent = T('bad_hijri'); hint.className += ' decl-warn'; }
      }
    }
    function renderBl(d, cmp) {
      var s = section_(T('sec_bl'));
      var v = blView(d, cmp);
      var tone = { match: 'success', mismatch: 'danger', no_transaction_bl: 'muted', not_read: 'warning' }[v.status] || 'muted';
      var p = el('p', 'decl-bl-status');
      p.appendChild(el('span', 'badge badge-' + tone, T('bl_' + v.status)));
      if (v.matchedWith) { p.appendChild(el('span', null, ' ' + T('bl_matched_with') + ' ')); p.appendChild(bdi(v.matchedWith, true)); }
      s.appendChild(p);
      var dl = el('dl', 'adm-dl decl-dl');
      function row(k, node) { var x = el('div'); x.appendChild(el('dt', null, k)); var dd = el('dd'); dd.appendChild(node); x.appendChild(dd); dl.appendChild(x); }
      // the B/L exactly as read: never replaced, shown as printed (plaintext bidi keeps the original order)
      var raw = el('bdi', 'num decl-bl-raw', v.raw || T('none')); raw.dir = 'ltr';
      row(T('bl_raw'), raw);
      row(T('bl_tx'), v.transactionBls.length ? (function () { var w = el('span'); v.transactionBls.forEach(function (b, i) { if (i) w.appendChild(el('span', null, ' · ')); w.appendChild(bdi(b, true)); }); return w; })() : el('span', 'text-muted', T('none')));
      s.appendChild(dl);
      if (v.candidates.length) {
        s.appendChild(el('h4', 'decl-h4', T('bl_candidates')));
        var ul = el('ul', 'decl-chips');
        v.candidates.forEach(function (c) {
          var li = el('li', 'decl-chip' + (c.matches ? ' is-match' : ''));
          li.appendChild(bdi(c.value, true));
          if (c.printed) li.appendChild(el('span', 'decl-chip-tag', T('bl_printed')));
          if (c.matches) li.appendChild(el('span', 'decl-chip-tag', T('bl_eq')));
          ul.appendChild(li);
        });
        s.appendChild(ul);
      }
      if (v.rtl) s.appendChild(alertBox('warning', T('bl_rtl')));
      s.appendChild(el('p', 'form-hint', T('bl_never_replaced')));
      if (v.status === 'mismatch' && editable()) {
        var lab = el('label', 'check decl-confirm');
        var cb = el('input'); cb.type = 'checkbox'; cb.id = 'decl-confirm-bl'; cb.checked = !!S.form.confirmBl;
        cb.addEventListener('change', function () {
          S.form.confirmBl = cb.checked;
          // the local B/L refusal no longer applies once the reviewer confirms the B/L
          if (cb.checked && S.approveError && S.approveError.code === 'MRS_DECL_BL_MISMATCH') {
            S.approveError = null;
            var m = document.getElementById('decl-approve-msg'); if (m) m.textContent = '';
          }
          refreshChecks();
        });
        lab.appendChild(cb); lab.appendChild(el('span', null, ' ' + T('bl_confirm')));
        s.appendChild(lab);
      }
      return s;
    }
    function cellInput(list, i, key, o) {
      o = o || {};
      var inp = el('input', 'form-control decl-cell' + (o.wide ? ' is-wide' : '') + (key === 'container_number' ? ' decl-cell-ctr' : ''));
      inp.type = 'text';
      inp.value = list[i][key] == null ? '' : list[i][key];
      if (o.ltr) inp.dir = 'ltr';
      if (o.max) inp.maxLength = o.max;
      inp.setAttribute('aria-label', o.label + ' #' + (i + 1));
      inp.setAttribute('data-row', String(i));
      inp.setAttribute('data-key', key);
      inp.disabled = !editable();
      inp.addEventListener('input', function () { list[i][key] = inp.value; S.dirty = true; if (o.onInput) o.onInput(inp); refreshChecks(); });
      return inp;
    }
    function tableBox(title, cols, extra) {
      var wrap = el('div', 'table-wrap decl-table-wrap');
      var tbl = el('table', 'table decl-table');
      tbl.appendChild(el('caption', 'sr-only', title));
      var th = el('thead'), tr = el('tr');
      tr.appendChild(el('th', 'num', '#'));
      cols.forEach(function (c) { var x = el('th', null, c); x.scope = 'col'; tr.appendChild(x); });
      (extra || []).forEach(function (c) { tr.appendChild(el('th', null, c)); });
      th.appendChild(tr); tbl.appendChild(th);
      var tb = el('tbody'); tbl.appendChild(tb);
      wrap.appendChild(tbl);
      return { wrap: wrap, tbody: tb };
    }
    function renderContainers() {
      var s = section_(T('sec_containers'));
      s.id = 'decl-containers';
      var cargo = S.review.cargo_unit_type;
      if (cargo === 'roro') { s.appendChild(el('p', 'text-sm text-muted', T('roro_none'))); }
      var list = S.form.containers;
      var tb = tableBox(T('sec_containers'), [T('c_container'), T('c_seal'), T('c_size'), T('c_gross'), T('c_merge')], editable() ? [''] : []);
      var badgeTds = [];
      // review fix: one preview for the whole list — every row's badge, the summary and the transaction-only list follow
      // each edit of a container number (the inputs are not rebuilt: the focus stays)
      function refresh() {
        var pv = containerPreview(list, S.review.comparison);
        badgeTds.forEach(function (td, i) {
          var p = pv.rows[i] || {};
          td.textContent = '';
          var tone = { new: 'navy', on_tx: 'info', other_tx: 'danger', invalid: 'danger', dup: 'warning', empty: 'muted' }[p.state] || 'muted';
          td.appendChild(el('span', 'badge badge-sm badge-' + tone, T('m_' + (p.state || 'empty'))));
        });
        sum.textContent = T('merge_sum', { a: pv.added, u: pv.onTx, k: pv.txOnly.length }) + (pv.otherTx ? ' ' + T('merge_sum_other', { n: pv.otherTx }) : '');
        only.textContent = pv.txOnly.length ? T('merge_tx_only', { list: pv.txOnly.join(lang() === 'en' ? ', ' : '، ') }) : '';
        only.hidden = !pv.txOnly.length;
      }
      function paint() {
        tb.tbody.textContent = '';
        badgeTds = [];
        if (!list.length) { var e = el('tr'); var td = el('td', 'text-muted', T('rows_empty')); td.colSpan = 7; e.appendChild(td); tb.tbody.appendChild(e); }
        list.forEach(function (c, i) {
          var tr = el('tr');
          tr.appendChild(el('td', 'num', String(i + 1)));
          var badgeTd = el('td');
          badgeTds.push(badgeTd);
          [['container_number', 11, true], ['seal_number', 30, true], ['size_type', 10, true], ['gross_weight', 20, true]].forEach(function (k) {
            var td = el('td');
            td.appendChild(cellInput(list, i, k[0], { ltr: k[2], max: k[1], label: T('c_' + { container_number: 'container', seal_number: 'seal', size_type: 'size', gross_weight: 'gross' }[k[0]]), onInput: k[0] === 'container_number' ? refresh : null }));
            tr.appendChild(td);
          });
          tr.appendChild(badgeTd);
          if (editable()) {
            var tdx = el('td');
            tdx.appendChild(btn(T('row_remove'), 'btn-ghost decl-danger', function () { list.splice(i, 1); S.dirty = true; paint(); refreshChecks(); }));
            tr.appendChild(tdx);
          }
          tb.tbody.appendChild(tr);
        });
        refresh();
      }
      var sum = el('p', 'text-sm decl-merge-sum');
      var only = el('p', 'text-sm text-muted');
      s.appendChild(sum);
      s.appendChild(tb.wrap);
      s.appendChild(only);
      if (editable() && cargo !== 'roro') {
        s.appendChild(btn(T('row_add'), 'btn-ghost', function () {
          if (list.length >= MAX_CTR) { toast(T('rows_max', { n: MAX_CTR }), 'warning'); return; }
          list.push({ container_number: '', seal_number: '', size_type: '', gross_weight: '' }); S.dirty = true; paint();
        }));
      }
      s.appendChild(el('p', 'form-hint', T('merge_hint')));
      paint();
      return s;
    }
    function renderItems() {
      var s = section_(T('sec_items'));
      s.id = 'decl-items';
      var list = S.form.items;
      var cols = ITEM_COLS.map(function (c) { return T('i_' + c); });
      var tb = tableBox(T('sec_items'), cols, [T('i_ref')].concat(editable() ? [''] : []));
      var pickHost = el('div', 'decl-picker-host');
      function paint() {
        tb.tbody.textContent = '';
        if (!list.length) { var e = el('tr'); var td = el('td', 'text-muted', T('rows_empty')); td.colSpan = ITEM_COLS.length + 3; e.appendChild(td); tb.tbody.appendChild(e); }
        list.forEach(function (it, i) {
          var tr = el('tr');
          tr.appendChild(el('td', 'num', String(i + 1)));
          ITEM_COLS.forEach(function (c) {
            var td = el('td');
            td.appendChild(cellInput(list, i, c, { ltr: c === 'hs_code' || ITEM_NUM.indexOf(c) !== -1, max: c === 'description' ? 2000 : c === 'hs_code' ? 20 : 120,
              wide: c === 'description', label: T('i_' + c) }));
            tr.appendChild(td);
          });
          var tdr = el('td');
          var rb = btn(T('hs_open'), 'btn-ghost decl-hs-btn', function () { openPicker(i); });
          rb.setAttribute('aria-label', T('hs_open_aria', { n: i + 1 }));
          rb.disabled = !window.MarsaHsPicker;
          tdr.appendChild(rb);
          tr.appendChild(tdr);
          if (editable()) {
            var tdx = el('td');
            tdx.appendChild(btn(T('row_remove'), 'btn-ghost decl-danger', function () { list.splice(i, 1); S.dirty = true; closePicker(); paint(); refreshChecks(); }));
            tr.appendChild(tdx);
          }
          tb.tbody.appendChild(tr);
        });
      }
      function closePicker() { if (S.picker) { S.picker.close(); S.picker = null; } }
      function openPicker(i) {
        closePicker();
        if (!window.MarsaHsPicker) return;
        var it = list[i] || {};
        var P = window.MarsaHsPicker.panel({
          api: API, orgId: S.orgId, query: window.MarsaHsPicker.pure.queryOf(it), t: T,
          onPick: editable() ? function (h) {
            if (!list[i]) return;
            list[i].hs_code = String(h.hs_code || '');
            if (blank(list[i].description) && h.description_ar) list[i].description = String(h.description_ar);
            if (blank(list[i].scientific_name) && h.scientific_name) list[i].scientific_name = String(h.scientific_name);
            S.dirty = true; closePicker(); paint(); refreshChecks();
            toast(T('hs_picked', { code: h.hs_code || '', n: i + 1 }), 'success');
          } : null,
          // review fix: every close (the panel's own «إغلاق», a pick, a re-render) also removes the «row n» line above it
          onClose: function () { if (S.picker === P) S.picker = null; pickHost.textContent = ''; }
        });
        S.picker = P;
        pickHost.appendChild(el('p', 'text-sm decl-picker-for', T('hs_for_row', { n: i + 1 })));
        pickHost.appendChild(P.el);
        P.search();
        if (P.input && P.input.focus) P.input.focus();
      }
      s.appendChild(tb.wrap);
      if (editable()) {
        s.appendChild(btn(T('row_add'), 'btn-ghost', function () {
          if (list.length >= MAX_ITEMS) { toast(T('rows_max', { n: MAX_ITEMS }), 'warning'); return; }
          var o = {}; ITEM_KEYS.forEach(function (k) { o[k] = ''; }); list.push(o); S.dirty = true; paint();
        }));
      }
      s.appendChild(pickHost);
      s.appendChild(el('p', 'form-hint', T('items_hint')));
      paint();
      return s;
    }
    function refreshChecks() {
      var box = document.getElementById('decl-checks');
      if (!box || !S.review || !S.form) return;
      box.textContent = '';
      var cmp = S.review.comparison || {}, cargo = S.review.cargo_unit_type;
      var miss = localMissing(S.form, cargo), bad = validateForm(S.form, cargo);
      var o = buildPayload(S.form, S.review.version, cargo);
      var confs = effectiveConflicts(o, cmp, S.review.draft);
      paintPlan(planOf(o, cmp), cmp);
      if (confs.length) {
        box.appendChild(el('h4', 'decl-h4', T('conflicts_title')));
        var ul = el('ul', 'decl-chips');
        confs.forEach(function (c) {
          var li = el('li', 'decl-chip ' + (c.blocking ? 'is-blocking' : 'is-warn'), T('conf_' + c.code) === 'conf_' + c.code ? String(c.code) : T('conf_' + c.code));
          if (c.blocking) li.appendChild(el('span', 'decl-chip-tag', c.confirmable ? T('conf_confirmable') : T('conf_blocking')));
          ul.appendChild(li);
        });
        box.appendChild(ul);
      }
      if (miss.length) {
        box.appendChild(el('h4', 'decl-h4', T('missing_title')));
        var mu = el('ul', 'decl-chips');
        miss.forEach(function (m) { mu.appendChild(el('li', 'decl-chip is-missing', T('miss_' + m))); });
        box.appendChild(mu);
      }
      // field-level problems next to their field (the error element is shown explicitly, never left display:none)
      Array.prototype.forEach.call(root.querySelectorAll('.decl-field-error'), function (n) { n.textContent = ''; n.hidden = true; });
      Array.prototype.forEach.call(root.querySelectorAll('.decl-cell'), function (n) { n.classList.remove('is-invalid'); n.removeAttribute('aria-invalid'); });
      bad.forEach(function (b) {
        if (b.row == null) {
          var g = root.querySelector('[data-field="' + b.field + '"] .decl-field-error');
          if (g) { g.textContent = T(b.code); g.hidden = false; }
        } else {
          Array.prototype.forEach.call(root.querySelectorAll('#decl-' + b.table + ' .decl-cell'), function (n) {
            if (n.getAttribute('data-row') === String(b.row) && n.getAttribute('data-key') === b.field) { n.classList.add('is-invalid'); n.setAttribute('aria-invalid', 'true'); }
          });
        }
      });
      if (bad.length) box.appendChild(el('p', 'decl-error', T('fix_fields', { n: bad.length })));
      var ab = document.getElementById('decl-approve-btn');
      if (ab) ab.disabled = !editable() || !!miss.length || !!bad.length || hardBlock(confs);
    }
    // the «what approval will do» lines of the declaration section, from the edited values
    function paintPlan(plan, cmp) {
      var box = document.getElementById('decl-plan');
      if (!box) return;
      box.textContent = '';
      var ex = (cmp.declaration || {}).existing, act = plan.action;
      var ap = el('p', 'text-sm decl-action');
      ap.appendChild(el('span', 'badge badge-sm ' + (act === 'conflict' ? 'badge-danger' : act === 'add' ? 'badge-navy' : 'badge-info'), T('act_' + act)));
      ap.appendChild(el('span', null, ' ' + (ex ? T('act_existing', { n: ex.declaration_no || '', s: stLabel(ex.status) }) : T('act_none'))));
      box.appendChild(ap);
      if (plan.direction !== 'unknown' && plan.direction !== 'initial') {
        box.appendChild(el('p', 'text-sm ' + (plan.direction === 'backward' ? 'decl-warn' : 'text-muted'),
          T('dir_' + plan.direction, { from: stLabel(plan.current), to: stLabel(plan.status) })));
      }
      if (plan.replaced.length) {
        box.appendChild(el('p', 'text-sm decl-warn', T('cf_replace', { list: plan.replaced.map(function (f) { return T('tf_' + f); }).join(lang() === 'en' ? ', ' : '، ') })));
      }
    }
    function renderApprove() {
      var box = el('div', 'ocr-block decl-approve');
      box.id = 'decl-approve';
      var msg = el('div', 'decl-approve-msg'); msg.id = 'decl-approve-msg';
      if (S.approveError) {
        msg.appendChild(errorLine(S.approveError));
        var code = S.approveError.code;
        if (code === 'MRS_DECL_STALE') msg.appendChild(btn(T('reload'), 'btn-secondary', function () { loadReview(S.route.extraction, S.route.tx, { keepForm: true }); }));
        if (code === 'MRS_DUPLICATE_TX') msg.appendChild(el('p', 'text-sm text-muted', T('dup_hint')));
      }
      if (S.notice && !S.approveError) { var nt = el('p', 'text-sm decl-notice', S.notice); nt.setAttribute('role', 'status'); msg.appendChild(nt); }
      box.appendChild(msg);
      if (S.review.approval) return box;
      if (!S.writer) { box.appendChild(el('p', 'text-sm text-muted', T('read_only_role'))); return box; }
      var b = btn(S.approving ? T('approving') : T('approve'), 'btn-primary btn-lg', approve);
      b.id = 'decl-approve-btn';
      b.disabled = !editable();
      box.appendChild(b);
      box.appendChild(el('p', 'form-hint', T('approve_hint')));
      return box;
    }
    function approve() {
      if (!editable() || S.approving) return;
      var rv = S.review, cargo = rv.cargo_unit_type;
      var miss = localMissing(S.form, cargo), bad = validateForm(S.form, cargo);
      if (miss.length || bad.length) { refreshChecks(); return; }
      var v = blView(rv.draft || {}, rv.comparison || {});
      if (v.status === 'mismatch' && !S.form.confirmBl) {
        S.approveError = { code: 'MRS_DECL_BL_MISMATCH', message: T('bl_confirm_needed') };
        render(); focusApprove(); return;
      }
      var o = buildPayload(S.form, rv.version, cargo);
      if (hardBlock(effectiveConflicts(o, rv.comparison || {}, rv.draft))) { refreshChecks(); return; }
      var pv = containerPreview(S.form.containers, rv.comparison);
      // review fix: the action / status move / replaced fields of the EDITED values (not of the values read)
      var plan = planOf(o, rv.comparison || {});
      var sep = lang() === 'en' ? ', ' : '، ';
      var body = el('div');
      [T('cf_action', { a: T('act_' + plan.action) }), T('cf_no', { n: o.declarationNo || '' }),
        T('cf_status', { s: stLabel(o.status) }),
        plan.direction !== 'unknown' && plan.direction !== 'initial' ? T('dir_' + plan.direction, { from: stLabel(plan.current), to: stLabel(plan.status) }) : null,
        T('cf_date', { d: o.declarationDate || '', h: o.declarationDateHijri || T('none') }),
        plan.replaced.length ? T('cf_replace', { list: plan.replaced.map(function (f) { return T('tf_' + f); }).join(sep) }) : null,
        T('cf_containers', { a: pv.added, u: pv.onTx }), T('cf_items', { n: o.items.length }),
        T('cf_bl', { s: T(v.status === 'mismatch' ? 'bl_mismatch_confirmed' : 'bl_' + v.status) }), T('cf_tx_rule'), T('cf_daftra')].forEach(function (ln) {
        if (ln) body.appendChild(el('p', 'decl-confirm-line', ln));
      });
      askConfirm({ title: T('cf_title'), body: body, text: body.textContent, okText: T('approve') }).then(function (yes) {
        if (!yes) return;
        S.idem = approveKey(S.idem, rv.version, o, uuid);
        if (S.idem.key) o.idemKey = S.idem.key;
        S.approving = true; S.approveError = null; S.notice = null; render(); focusApprove();
        API.approveDeclarationExtraction(rv.extraction_id, rv.transaction_id, o).then(function (r) {
          S.approving = false;
          if (!r || r.error) { S.approveError = (r && r.error) || { message: T('err_generic') }; render(); focusApprove(); return; }
          S.result = r.data || {}; S.dirty = false;
          render();
          announce(T('approved'));
          toast(T('approved'), 'success');
        }, function (e) { S.approving = false; S.approveError = e; render(); focusApprove(); });
      });
    }
    function focusApprove() { var m = document.getElementById('decl-approve-msg'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center' }); }
    function renderResult() {
      var r = resultSummary(S.result);
      var box = el('div', 'ocr-block decl-result');
      box.appendChild(alertBox('success', r.replayed ? T('approved_replayed') : T('approved')));
      var ul = el('ul', 'decl-result-list');
      function li(text) { ul.appendChild(el('li', null, text)); }
      var sep = lang() === 'en' ? ', ' : '، ';
      li(T('r_decl', { n: r.declarationNo, a: T('ra_' + (r.action || 'unchanged')) }));
      li(T('r_status', { a: T('rs_' + (r.statusAction || 'same')) }));
      li(T('r_bl', { s: T('rb_' + (r.bl || 'not_read')) }) + (r.blWith ? ' (' + r.blWith + ')' : ''));
      li(T('r_ctr', { a: r.added.length, u: r.updated.length, k: r.unchanged.length }) + (r.added.length ? ' — ' + T('r_added', { list: r.added.join(sep) }) : ''));
      li(T('r_items', { n: r.items }));
      li(T('r_hs', { n: r.hsSaved }));
      if (r.filled.length) li(T('r_filled', { list: r.filled.map(function (f) { return T('tf_' + f); }).join(sep) }));
      if (r.kept.length) li(T('r_kept', { list: r.kept.map(function (f) { return T('tf_' + f); }).join(sep) }));
      if (r.replaced.length) li(T('r_replaced', { list: r.replaced.map(function (f) { return T('tf_' + f); }).join(sep) }));
      r.warnings.forEach(function (w) { li(T('w_' + w) === 'w_' + w ? String(w) : T('w_' + w)); });
      // legacy step 7: whether the approval requested the opening Daftra draft (org setting, OFF by default; finance only)
      var DK = window.MarsaOps && window.MarsaOps.dftKit;
      if (DK && API && S.route && S.route.tx) {
        // review: the <li> stays hidden (no empty bullet) until the note has text — non-finance users see nothing
        var liD = el('li'); liD.hidden = true;
        liD.appendChild(DK.openingNote(API, S.route.tx, { cls: 'decl-result-daftra', host: liD })); ul.appendChild(liD);
      }
      else li(T('r_daftra'));
      box.appendChild(ul);
      var bar = el('div', 'decl-actions');
      // a DRAFT transaction (20261127000100): the next step is the match of this declaration with the invoice + B/L
      // (ocr.html#match-tx, three-way) and then «اعتماد المعاملة» on the transaction page
      var draft = !!(S.tx && S.tx.id === S.route.tx && S.tx.is_draft);
      if (draft) {
        box.appendChild(alertBox('info', T('approved_draft_next')));
        var mt = el('a', 'btn btn-sm btn-primary', T('match_tx')); mt.href = matchTxLink(S.route.tx, S.result && S.result.extraction_id);
        bar.appendChild(mt);
      }
      var a = el('a', 'btn btn-sm ' + (draft ? 'btn-secondary' : 'btn-primary'), T('open_tx')); a.href = txLink(S.route.tx);
      bar.appendChild(a);
      if (r.batchId) { var b = el('a', 'btn btn-sm btn-ghost', T('m_batch_link')); b.href = batchLink(r.batchId); bar.appendChild(b); }
      box.appendChild(bar);
      return box;
    }

    init();
  });
})();
