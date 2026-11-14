/* ==========================================================================
   مرسى | MARSA — ocr.html: invoice ↔ B/L ↔ customs declaration ↔ packing list matching (AI)
   Plain IIFE, no modules. Depends on window.MarsaDocMatch (doc-match.js, the pure
   engine), window.MarsaApi (supa.js), window.XlsxLite (xlsx-lite.js), optional
   window.MarsaShell (app-shell.js) and window.MarsaI18n (strings 'ocr.m_*').

   - Shown only online, to signed-in staff, when MarsaApi.aiAccess says the org may use
     AI reading (same gate as the AI engine in ocr.js). Each document is one AI reading
     (MarsaApi.aiExtract, run in parallel): 2 readings, 3 with the declaration, up to 4 with the packing list
     (بيان التعبئة: doc_type 'packing_list'). Every slot is read with prompt 'ai-doc-v3' (extended keys, containers);
     a v3 answer with reused:true is a reading already saved: no charge, its extraction_id is used as is).
   - mode (two_way / three_way) is decided by the declaration only; a packing list adds a column, the pairs
     inv_pack / bl_pack / decl_pack and engine version match-v2 (saved with packing_extraction_id, 20261126000100).
   - Result: MarsaDocMatch.compare → banner + table (values editable → instant
     recompute, flagged 'corrected'), items / warnings, per-row "reviewed" ticks.
   - Save: MarsaApi.saveExtraction for each reading (engine claude, ai_usage_id,
     optional transaction link / original upload as in ocr.js), then
     MarsaApi.saveDocumentMatch, then reviewDocumentMatch when approved. Readings that
     were saved are never saved twice (a retry continues where it stopped).
   - Exports: PNG drawn on a <canvas> here (no library), print (print CSS keeps only
     the report), Excel (XlsxLite), JSON.
   - compareReadings (window.MarsaOcrMatch, 2026-11-12): readings already made by the single reader (ocr.js) are
     loaded into this report with NO new AI call — 2+ of the 4 slots, the parts of a combined file (by_document) as
     entries of their own. Same engine and renderers; readings the reader saved are reused by id, unsaved ones are saved
     the usual way; a part of a combined file cannot be saved (one AI reading = one extraction): save is disabled with
     a note. shipmentCheck (UI only) shows «يبدو أن هذه المستندات لشحنات مختلفة» when the documents clearly belong
     to different shipments (the comparison is still shown).
   - Check level (2026-11-13): always MarsaDocMatch 'strict' (the «تدقيق شديد» checkbox was removed on the owner's request). Formerly: 'basic': numbers /
     codes exact, names and kinds match from 60% similarity (or one containing the other); ticked = 'strict': text exact too.
     Remembered in localStorage (marsa.ocr.match.check); toggling recomputes without an AI call; shown in the report meta,
     print, Excel, PNG, JSON (check_mode) and recorded as the last line of the saved note (the SQL has no field for it).
   - Untrusted values (readings, file names, server rows) only ever via textContent /
     value. The backend functions (saveDocumentMatch …) are feature-detected.
   ========================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var section = document.getElementById('ocr-match-section');
    var E = window.MarsaDocMatch;
    if (!section || !E) return;
    var API = window.MarsaApi || null;
    var X = window.XlsxLite || null;
    var Shell = window.MarsaShell || null;
    var I18N = window.MarsaI18n || null;
    var $ = function (id) { return document.getElementById(id); };
    var qsa = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
    var M = window.Marsa || {};
    var toast = Shell && typeof Shell.toast === 'function' ? function (m, t) { Shell.toast(m, t); }
      : (M.toast || function (m) { try { console.log(m); } catch (e) { /* noop */ } });

    function T(key, vars) {
      var k = 'ocr.' + key;
      return I18N && typeof I18N.t === 'function' && (!I18N.has || I18N.has(k)) ? I18N.t(k, vars) : key;
    }
    function lang() { return I18N && typeof I18N.lang === 'function' && I18N.lang() === 'en' ? 'en' : 'ar'; }
    function L(row, base) { return lang() === 'en' ? row[base + '_en'] : row[base + '_ar']; }

    /* ---------------------------------------------------------------
       Constants (same limits as the AI engine in ocr.js / supa.js)
       --------------------------------------------------------------- */
    var ENGINE_AI = 'claude-opus-5-5';
    var AI_MAX_FILE = 10 * 1024 * 1024;           // PDF
    var AI_MAX_IMAGE = 5 * 1024 * 1024;           // image
    var AI_MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
    var SLOTS = ['invoice', 'bl', 'declaration', 'packing'];
    var DOC_TYPE = { invoice: 'commercial_invoice', bl: 'bill_of_lading', declaration: 'customs_declaration', packing: 'packing_list' };
    // every slot is read with the ai-doc-v3 prompt (the packing list exists only there; the invoice / B/L / declaration
    // get the extended keys — seals, notify party, booking, places, freight, CBM, shipping line, the declaration keys — which
    // the per-document sheets list; the match engine (doc-match.js) compares its own keys only, unchanged)
    var PROMPT = { invoice: 'ai-doc-v3', bl: 'ai-doc-v3', declaration: 'ai-doc-v3', packing: 'ai-doc-v3' };
    // «القراءة السريعة» (2026-11-14): every slot read with reading_mode 'quick' while the switch is on (default ON; the
    // same preference as the single reader, ocr.js). The comparison is unchanged: every key doc-match compares is a quick
    // key, and the items are compared on description / HS / quantity / amount (the compact columns).
    var QUICK_PREF = 'marsa.ocr.quick';
    function quickPref() { try { return window.localStorage.getItem(QUICK_PREF) !== '0'; } catch (e) { return true; } }
    function setQuickPref(on) { try { window.localStorage.setItem(QUICK_PREF, on ? '1' : '0'); } catch (e) { /* storage blocked */ } }
    function quickOn() { var c = document.getElementById('ocr-match-quick'); return c ? !!c.checked : quickPref(); }
    function isQuickRes(res) { return !!(res && res.reading_mode === 'quick'); }
    function ask(o) {
      if (Shell && typeof Shell.confirm === 'function') return Promise.resolve(Shell.confirm(o)).then(function (v) { return !!v; });
      return Promise.resolve(window.confirm(o.text || o.title));
    }
    var PAIR_DOCS = E.PAIRS && E.PAIRS.inv_pack ? E.PAIRS : { inv_bl: ['invoice', 'bl'], inv_decl: ['invoice', 'declaration'], bl_decl: ['bl', 'declaration'],
      inv_pack: ['invoice', 'packing'], bl_pack: ['bl', 'packing'], decl_pack: ['declaration', 'packing'] };
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var LOW_CONF = 0.6;
    var STATUS_CLS = { match: 'is-match', mismatch: 'is-mismatch', partial: 'is-partial', missing: 'is-missing', info: 'is-info' };
    var OVERALL_CLS = { match: 'is-match', review: 'is-partial', mismatch: 'is-mismatch' };
    var COLORS = {
      match: ['#0D6B44', '#E3F5EC'], mismatch: ['#A0252E', '#FDECEE'], partial: ['#8A5E04', '#FFF4DC'], missing: ['#475569', '#EEF2F6'],
      info: ['#0E7F84', '#E3F6F6'], review: ['#8A5E04', '#FFF4DC']
    };

    /* ---------------------------------------------------------------
       State
       --------------------------------------------------------------- */
    var ONLINE = !!(API && API.isOnline && API.isOnline());
    var STAFF = false;
    var AI = { enabled: false, remaining: null };
    var S = null;
    function fresh() {
      var s = { slots: {}, result: null, reviewed: {}, approved: false, orgId: null, saving: false, running: false,
        saved: { extractions: {}, match: null }, readAt: null, bridge: null };
      SLOTS.forEach(function (k) { s.slots[k] = { file: null, sha256: '', status: 'empty', res: null, fields: null, orig: null, items: [], error: '' }; unbridge(s.slots[k]); });
      return s;
    }
    // a slot filled by compareReadings (readings of the single reader): label, part of a combined file, saved-row getter
    function unbridge(s) { s.label = ''; s.fileName = ''; s.part = false; s.savedRef = null; s.onSaved = null; s.bridged = false; }
    S = fresh();

    /* ---------------------------------------------------------------
       Small helpers
       --------------------------------------------------------------- */
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function ext(name) { var i = String(name || '').lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''; }
    function mediaType(f) {
      var t = String(f.type || '').toLowerCase();
      var byType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].indexOf(t) !== -1 ? t : null;
      return byType || AI_MEDIA[ext(f.name)] || null;
    }
    function fmtSize(b) { return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB'; }
    function fmtDate(iso) {
      try {
        if (I18N && I18N.fmtDate) return I18N.fmtDate(iso, { time: true });
        return new Date(iso).toLocaleString(lang() === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn-ca-gregory');
      } catch (e) { return String(iso || ''); }
    }
    function stamp() {
      var d = new Date();
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    }
    function announce(msg) { var s = $('ocr-match-live'); if (s) s.textContent = msg; }
    function errMsg(err) { return (err && err.message) || (API && API.errorMessage ? API.errorMessage(err) : T('m_err_generic')); }
    function download(blob, name) {
      var url = URL.createObjectURL(blob);
      var a = el('a'); a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
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
      if (!(window.crypto && crypto.subtle)) return Promise.resolve('');
      return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).catch(function () { return ''; });
    }
    function docName(k) { return T('m_doc_' + k); }
    // the name shown for a slot's document: the file name, or «<file> — <part>» for a part of a combined file
    function slotLabel(k) { var s = S.slots[k]; return s.label || (s.file ? s.file.name : ''); }
    function activeOrg() {
      if (!ONLINE || !API || !API.activeOrgId) return Promise.resolve(null);
      return API.activeOrgId().then(function (r) { return r && !r.error ? r.data || null : null; }, function () { return null; });
    }
    function shellOrg() {
      if (!Shell || typeof Shell.orgId !== 'function') return null;
      try { var o = Shell.orgId(); return typeof o === 'string' && o ? o : null; } catch (e) { return null; }
    }
    function orgName(id) {
      if (!Shell || typeof Shell.orgs !== 'function') return '';
      try { var o = Shell.orgs().filter(function (x) { return x.org_id === id; })[0]; return o ? o.name || '' : ''; } catch (e) { return ''; }
    }
    function reviewerName() {
      if (Shell && typeof Shell.user === 'function') {
        try { var u = Shell.user(); if (u && u.name) return u.name; } catch (e) { /* noop */ }
      }
      return S.userEmail || '';
    }
    function has(fn) { return !!(API && typeof API[fn] === 'function'); }

    /* ---------------------------------------------------------------
       Access gate (same rule as the AI engine in ocr.js)
       --------------------------------------------------------------- */
    function initRole() {
      if (!ONLINE || !API) return Promise.resolve(false);
      return API.getSession().then(function (s) {
        if (s.error || !s.data) return false;
        if (s.data.user && s.data.user.email) S.userEmail = s.data.user.email;
        return API.isStaff().then(function (r) { return !r.error && !!r.data; });
      }).catch(function () { return false; });
    }
    function initAi() {
      AI.enabled = false; AI.remaining = null;
      if (!ONLINE || !STAFF || !API || typeof API.aiAccess !== 'function' || typeof API.aiExtract !== 'function') { syncGate(); return Promise.resolve(false); }
      return activeOrg().then(function (oid) { return API.aiAccess(oid || undefined); }).then(function (r) {
        AI.enabled = !!(r && !r.error && r.data && r.data.can_use === true);
        AI.remaining = AI.enabled && r.data.daily_remaining != null ? Number(r.data.daily_remaining) : null;
        syncGate();
        return AI.enabled;
      }, function () { syncGate(); return false; });
    }
    function syncGate() {
      var show = ONLINE && STAFF && AI.enabled;
      // a result on screen stays visible (it can still be exported / saved) even if access changed meanwhile
      section.hidden = !show && !S.result;
      showRemaining();
      syncRun();
      if (show) loadRecent();
    }
    function showRemaining() {
      var n = $('ocr-match-remaining');
      if (n) n.textContent = AI.remaining == null ? '' : T('ai_remaining', { n: AI.remaining });
    }

    /* ---------------------------------------------------------------
       Upload slots
       --------------------------------------------------------------- */
    function setFile(k, file) {
      var s = S.slots[k];
      if (S.running) return;
      if (!file) return;
      var mt = mediaType(file);
      if (!mt) { slotError(k, T('ai_unsupported')); return; }
      if (file.size > (mt === 'application/pdf' ? AI_MAX_FILE : AI_MAX_IMAGE)) { slotError(k, T('ai_too_large')); return; }
      // the same file in two slots would be one reading for two documents (and two charges): refused here
      var dupOf = null;
      SLOTS.forEach(function (o) {
        var f2 = o !== k && S.slots[o] && S.slots[o].file;
        if (f2 && f2.name === file.name && f2.size === file.size && f2.lastModified === file.lastModified) dupOf = o;
      });
      if (dupOf) { slotError(k, T('mx_dup_file', { doc: docName(dupOf) })); return; }
      if (S.result) clearResult();
      s.file = file; s.mime = mt; s.status = 'ready'; s.res = null; s.fields = null; s.orig = null; s.items = []; s.error = ''; s.sha256 = '';
      unbridge(s);
      delete S.saved.extractions[k];
      sha256(file).then(function (h) { if (s.file === file) s.sha256 = h; });
      renderSlot(k);
      syncRun();
    }
    function slotError(k, msg) {
      var s = S.slots[k];
      s.error = msg;
      renderSlot(k);
      announce(docName(k) + ': ' + msg);
    }
    function renderSlot(k) {
      var s = S.slots[k];
      var fn = qsa('[data-fname="' + k + '"]')[0], stEl = qsa('[data-status="' + k + '"]')[0], pr = qsa('[data-progress="' + k + '"]')[0];
      var clr = qsa('[data-clear="' + k + '"]')[0], drop = qsa('[data-drop="' + k + '"]')[0];
      fn.textContent = s.label ? s.label : s.file ? s.file.name + ' · ' + fmtSize(s.file.size) : T('m_formats');
      stEl.textContent = '';
      stEl.className = 'ocr-match-slot-status';
      var msg = s.error || (s.status === 'reading' ? T('ai_reading') : s.status === 'sending' ? T('ai_sending') : s.status === 'done' ? T('m_read_done') : '');
      if (msg) {
        stEl.textContent = msg;
        stEl.classList.add(s.error ? 'is-error' : (s.status === 'done' ? 'is-done' : 'is-busy'));
      }
      if (s.status === 'done' && s.res) {
        var mk = mismatchKind(k, s.res);
        if (mk) {
          var w = el('div', 'alert alert-warning ocr-match-type-warn', T('m_type_mismatch', { doc: docName(k), kind: kindName(mk) }));
          w.setAttribute('role', 'note');
          stEl.appendChild(w);
        }
        if (s.res.reused) stEl.appendChild(el('span', 'ocr-match-slot-conf', ' · ' + T('m_reused_free')));
        if (s.res.mean_confidence != null) stEl.appendChild(el('span', 'ocr-match-slot-conf', ' · ' + T('ai_conf', { n: Math.round(Number(s.res.mean_confidence)) })));
        if (isQuickRes(s.res)) {
          stEl.appendChild(el('span', 'badge badge-sm badge-warning ocr-quick-badge', T('quick_badge')));
          // the same file read in full (not for a reading already saved, a reused one or one brought from the single reader)
          if (s.file && !s.bridged && !s.res.reused && !S.saved.extractions[k] && !S.running) {
            var fb = el('button', 'btn btn-ghost btn-sm ocr-quick-full', T('quick_full_btn'));
            fb.type = 'button';
            fb.setAttribute('data-full', k);
            stEl.appendChild(fb);
          }
        }
      }
      var pct = s.status === 'sending' ? 3 : s.status === 'reading' ? Math.round(s.pct || 5) : s.status === 'done' ? 100 : 0;
      // a slot being read: three dots fading in and out one after another; the one bar is the total under the slots
      if ((s.status === 'sending' || s.status === 'reading') && !s.error) {
        var dots = el('span', 'ocr-dots'); dots.setAttribute('aria-hidden', 'true');
        for (var di = 0; di < 3; di++) dots.appendChild(el('i', null));
        stEl.appendChild(dots);
      }
      pr.hidden = true;
      syncTotal();
      pr.setAttribute('aria-valuenow', String(pct));
      pr.firstElementChild.style.width = pct + '%';
      clr.hidden = !s.file || S.running;
      drop.classList.toggle('has-file', !!s.file);
      drop.classList.toggle('is-error', !!s.error);
      var inp = $('ocr-match-file-' + k); if (inp) inp.disabled = S.running;
    }
    // the kind of document the reading says it is, when it is not the slot's (null otherwise)
    function mismatchKind(k, res) {
      if (!res) return null;
      var w = (res.warnings || []).filter(function (x) { return x && x.code === 'doc_type_mismatch'; })[0];
      if (w) return res.detected_type || res.doc_type;
      // a reused stored reading is returned as itself: it may be another kind of document
      if (res.reused && res.kind && res.kind !== DOC_TYPE[k]) return res.kind;
      return null;
    }
    function kindName(kind) {
      var map = { commercial_invoice: 'm_kind_invoice', bill_of_lading: 'm_kind_bl', customs_declaration: 'm_kind_declaration', supplier_invoice: 'm_kind_supplier',
        operator_invoice: 'm_kind_supplier', packing_list: 'm_kind_packing', certificate_of_origin: 'm_kind_origin' };
      return map[kind] ? T(map[kind]) : String(kind || T('m_kind_other'));
    }
    function needed() { return SLOTS.filter(function (k) { return S.slots[k].file && S.slots[k].status !== 'done'; }).length; }
    function syncRun() {
      var b = $('ocr-match-run');
      var ok = !!(S.slots.invoice.file && S.slots.bl.file) && !S.running && ONLINE && STAFF && AI.enabled;
      var n = needed();
      b.disabled = !ok || (n === 0 && !!S.result);
      $('ocr-match-reset').disabled = S.running;
    }
    SLOTS.forEach(function (k) {
      var inp = $('ocr-match-file-' + k), drop = qsa('[data-drop="' + k + '"]')[0];
      inp.addEventListener('change', function () { if (this.files && this.files[0]) setFile(k, this.files[0]); this.value = ''; });
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-dragover'); }); });
      ['dragleave', 'dragend'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('is-dragover'); }); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); drop.classList.remove('is-dragover');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) setFile(k, f);
      });
      qsa('[data-clear="' + k + '"]')[0].addEventListener('click', function () {
        if (S.running) return;
        var s = S.slots[k];
        s.file = null; s.status = 'empty'; s.res = null; s.fields = null; s.orig = null; s.items = []; s.error = ''; s.sha256 = '';
        unbridge(s);
        delete S.saved.extractions[k];
        // a report loaded from the single reader keeps comparing what is left (2+ documents)
        var left = SLOTS.filter(function (o) { return S.slots[o].res; }).length;
        if (S.result) { if ((S.slots.invoice.res && S.slots.bl.res) || (S.bridge && left >= 2)) recompute(); else clearResult(); }
        renderSlot(k); syncRun();
        inp.focus();
      });
      renderSlot(k);
    });

    /* ---------------------------------------------------------------
       Reading (parallel AI readings)
       --------------------------------------------------------------- */
    function readSlot(k, orgId) {
      var s = S.slots[k];
      s.status = 'sending'; s.error = ''; renderSlot(k);
      var stop = function () { if (s.timer) { clearInterval(s.timer); s.timer = null; } };
      stop();
      return fileB64(s.file).then(function (b64) {
        s.status = 'reading'; s.pct = 5; renderSlot(k);
        // one answer, no server progress: the bar eases 5% → 95% (time constant ~35 s) and jumps to 100% when done
        var t0 = Date.now();
        s.timer = setInterval(function () {
          if (s.status !== 'reading') { stop(); return; }
          s.pct = Math.min(95, 5 + 90 * (1 - Math.exp(-(Date.now() - t0) / 35000)));
          var pr = qsa('[data-progress="' + k + '"]')[0], stEl = qsa('[data-status="' + k + '"]')[0], p = Math.round(s.pct);
          if (pr) { pr.setAttribute('aria-valuenow', String(p)); pr.firstElementChild.style.width = p + '%'; }
          syncTotal();
        }, 400);
        var q = { orgId: orgId || undefined, docType: DOC_TYPE[k], file: { media_type: s.mime, data_b64: b64 }, lang: lang() };
        if (PROMPT[k]) q.promptVersion = PROMPT[k];
        if (q.promptVersion === 'ai-doc-v3' && !s.forceFull && quickOn()) q.readingMode = 'quick';
        return API.aiExtract(q);
      }).then(function (r) {
        if (!r || r.error || !r.data) throw (r && r.error) || new Error(T('m_err_generic'));
        // a v3 answer from a reading already saved (reused) was not charged
        if (AI.remaining != null && !r.data.reused) { AI.remaining = Math.max(0, AI.remaining - 1); showRemaining(); }
        stop();
        takeReading(k, r.data);
        s.forceFull = false;
        s.status = 'done'; renderSlot(k);
        return true;
      }).catch(function (e) {
        stop();
        s.status = 'ready'; s.error = errMsg(e); renderSlot(k);
        return false;
      });
    }
    // the Edge Function's answer → editable fields {key: {value, score}} (strings only)
    function takeReading(k, res) {
      var s = S.slots[k], fields = {}, orig = {};
      (res.fields || []).forEach(function (f) {
        if (!f || typeof f.name !== 'string' || typeof f.value !== 'string' || !/^[a-z_]{2,40}$/.test(f.name)) return;
        var c = Number(f.confidence); if (!isFinite(c)) c = null;
        fields[f.name] = { value: f.value, score: c };
        orig[f.name] = f.value;
      });
      s.res = res; s.fields = fields; s.orig = orig;
      s.items = Array.isArray(res.line_items) ? res.line_items.slice(0, 500) : [];
    }
    $('ocr-match-run').addEventListener('click', run);
    // «اقرأ المستند كاملًا» on a quick slot: asks first when a value of that document was corrected, then reads it again
    // in full (the other slots stay as read; the report is recomputed when the answer arrives)
    $('ocr-match-slots').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-full]') : null;
      if (!b) return;
      var k = b.getAttribute('data-full');
      if (SLOTS.indexOf(k) === -1) return;
      readFull(k);
    });
    function readFull(k) {
      var s = S.slots[k];
      if (S.running || !s.file || !isQuickRes(s.res)) return;
      var edited = Object.keys(s.fields || {}).some(function (x) { return s.fields[x] && s.fields[x].corrected; });
      var go = function () { s.forceFull = true; s.status = 'ready'; renderSlot(k); syncRun(); run(); };
      if (!edited) { go(); return; }
      ask({ title: T('quick_full_btn'), text: T('quick_full_confirm'), okText: T('quick_full_btn'), danger: true })
        .then(function (yes) { if (yes) go(); });
    }
    (function () {
      var c = $('ocr-match-quick');
      if (!c) return;
      c.checked = quickPref();
      c.addEventListener('change', function () {
        setQuickPref(c.checked);
        var o = $('ocr-quick'); if (o) o.checked = c.checked;     // the single reader shares the choice
      });
    })();
    function run() {
      if (S.running || !(S.slots.invoice.file && S.slots.bl.file)) return;
      if (!(ONLINE && STAFF && AI.enabled)) { showError(T('m_err_access')); return; }
      var todo = SLOTS.filter(function (k) { return S.slots[k].file && S.slots[k].status !== 'done'; });
      if (!todo.length) { recompute(); return; }
      if (AI.remaining != null && AI.remaining < todo.length) { showError(T('m_err_quota', { n: todo.length, r: AI.remaining })); return; }
      if (!S.hashWaited && todo.some(function (k) { return !S.slots[k].sha256; })) {
        // hashing may still be running for a large file: wait for it once (saving needs it)
        S.hashWaited = true;
        return Promise.all(todo.map(function (k) { return sha256(S.slots[k].file).then(function (h) { S.slots[k].sha256 = h; }); })).then(run);
      }
      showError('');
      SLOTS.forEach(function (k) { S.slots[k].inRun = todo.indexOf(k) !== -1; });
      S.running = true; syncRun();
      SLOTS.forEach(renderSlot);
      announce(T('m_reading_n', { n: todo.length }));
      var orgP = S.orgId ? Promise.resolve(S.orgId) : Promise.resolve(shellOrg()).then(function (o) { return o || activeOrg(); });
      orgP.then(function (oid) {
        S.orgId = oid || null;
        return Promise.all(todo.map(function (k) { return readSlot(k, S.orgId); }));
      }).then(function (oks) {
        S.running = false;
        SLOTS.forEach(renderSlot); syncTotal();
        S.readAt = new Date().toISOString();
        var failed = todo.filter(function (k, i) { return !oks[i]; });
        if (S.slots.invoice.res && S.slots.bl.res && (!S.slots.declaration.file || S.slots.declaration.res) && (!S.slots.packing.file || S.slots.packing.res)) {
          recompute(true);
        } else if (failed.length) {
          showError(T('m_err_failed', { docs: failed.map(docName).join('، ') }));
        }
        if (failed.length && S.result) showError(T('m_err_failed', { docs: failed.map(docName).join('، ') }));
        syncRun();
      }).catch(function (e) {
        S.running = false; SLOTS.forEach(renderSlot); syncRun(); syncTotal();
        showError(errMsg(e));
      });
    }
    // the total bar under the slots: the mean progress of the slots of this run (read / failed = 100)
    function syncTotal() {
      var box = $('ocr-match-progress');
      if (!box) return;
      var busy = SLOTS.filter(function (k) { var s = S.slots[k]; return s.inRun; });
      if (!S.running || !busy.length) { box.hidden = true; return; }
      var sum = 0, done = 0;
      busy.forEach(function (k) {
        var s = S.slots[k];
        var p = s.status === 'reading' ? (s.pct || 5) : s.status === 'sending' ? 3 : 100;
        if (s.status !== 'reading' && s.status !== 'sending') done++;
        sum += p;
      });
      var pct = Math.round(sum / busy.length);
      box.hidden = false;
      $('ocr-match-progress-label').textContent = T('fx_run_label', { done: done, n: busy.length });
      $('ocr-match-progress-pct').textContent = pct + '%';
      var bar = $('ocr-match-progress-bar');
      bar.setAttribute('aria-valuenow', String(pct));
      bar.firstElementChild.style.width = pct + '%';
    }
    function showError(msg) {
      $('ocr-match-error-text').textContent = msg || '';
      $('ocr-match-error').hidden = !msg;
      if (msg) announce(msg);
    }

    /* ---------------------------------------------------------------
       Compare + render
       --------------------------------------------------------------- */
    function engineInput() {
      var o = {};
      SLOTS.forEach(function (k) {
        var s = S.slots[k];
        if (s.res && s.fields) o[k] = { fields: s.fields, items: s.items };
      });
      return o;
    }
    /* check level: always strict (owner, 2026-11-13: «خلي الديفولت 100%، شيل التشيك») — every field, text too, must be
       equal (only case / spacing / tatweel / tashkeel are ignored); numbers are exact. The engine's 'basic' level stays
       available in doc-match.js but is not offered on the page. */
    var HAS_LEVEL = !!(E.CHECK_MODES && E.CHECK_MODES.indexOf('strict') !== -1);
    var CHECK = 'strict';
    function checkText(level) { return T(level === 'strict' ? 'mx_check_strict_name' : 'mx_check_basic_name'); }
    function recompute(focus, patch) {
      S.result = HAS_LEVEL ? E.compare(engineInput(), { mode: CHECK }) : E.compare(engineInput());
      // ticks survive a recompute for rows that still exist
      var keys = {}; S.result.rows.forEach(function (r) { keys[r.key] = 1; });
      Object.keys(S.reviewed).forEach(function (k) { if (!keys[k]) delete S.reviewed[k]; });
      render(patch);
      $('ocr-match-result').hidden = false;
      section.hidden = false;
      if (focus) revealReport();   // the errors summary (or the report) is scrolled to and focused
    }
    function clearResult() {
      S.result = null; S.reviewed = {}; S.approved = false; S.saved.match = null; S.idem = null;
      $('ocr-match-result').hidden = true;
      setSaveMsg('', '');
    }
    function cols() { return SLOTS.filter(function (k) { return S.result && S.result.documents.indexOf(k) !== -1; }); }
    // pair chips: whenever more than two documents are compared (three-way, or with the packing list)
    function multi(R) { return !!R && (R.mode === 'three_way' || R.documents.length > 2); }
    function modeText(R) {
      var m = R.mode === 'three_way' ? T('m_mode_three') : T('m_mode_two');
      return R.with_packing || R.documents.indexOf('packing') !== -1 ? T('m_mode_with_packing', { mode: m }) : m;
    }
    function correctedKeys(row) {
      var any = false;
      cols().forEach(function (k) {
        var src = row.src && row.src[k], f = src && S.slots[k].fields && S.slots[k].fields[src];
        if (f && f.corrected) any = true;
      });
      return any || !!row.corrected;
    }
    function render(patch) {
      var R = S.result;
      if (!R) return;
      // meta (report head)
      var meta = $('ocr-match-meta'); meta.textContent = '';
      function mrow(label, value) {
        if (!value) return;
        var d = el('div', 'ocr-match-meta-item'), dd = el('dd', null, value); dd.dir = 'auto';
        d.appendChild(el('dt', null, label)); d.appendChild(dd); meta.appendChild(d);
      }
      mrow(T('m_meta_date'), fmtDate(S.readAt || new Date().toISOString()));
      mrow(T('m_meta_org'), orgName(S.orgId));
      cols().forEach(function (k) { mrow(docName(k), slotLabel(k)); });
      mrow(T('m_meta_mode'), modeText(R));
      if (R.check_mode) mrow(T('mx_check_meta'), checkText(R.check_mode));
      // banner
      var ov = $('ocr-match-overall');
      ov.textContent = T('m_overall_' + R.overall);
      ov.className = 'ocr-match-overall ' + OVERALL_CLS[R.overall];
      $('ocr-match-banner').className = 'ocr-match-banner ' + OVERALL_CLS[R.overall];
      var cs = $('ocr-match-counts'); cs.textContent = '';
      ['match', 'partial', 'missing', 'mismatch'].forEach(function (st) {
        var c = el('span', 'ocr-match-chip ' + STATUS_CLS[st], T('m_st_' + st) + ': ' + R.counts[st]);
        cs.appendChild(c);
      });
      announce(T('m_overall_' + R.overall));
      // alerts: document type mismatches
      var al = $('ocr-match-alerts'); al.textContent = '';
      cols().forEach(function (k) {
        var mk = mismatchKind(k, S.slots[k].res);
        if (mk) {
          var a = el('div', 'alert alert-warning', T('m_type_mismatch', { doc: docName(k), kind: kindName(mk) }));
          a.setAttribute('role', 'note'); al.appendChild(a);
        }
      });
      // readings loaded from the single reader: what was used / left out (notes from the caller)
      ((S.bridge && S.bridge.notes) || []).forEach(function (t) {
        var a = el('div', 'alert alert-info ocr-mx-bridge-note', t);
        a.setAttribute('role', 'note'); al.appendChild(a);
      });
      var ship = shipmentCheck();
      if (ship) al.appendChild(shipmentBanner(ship));
      if (!(patch && patchTable())) renderTable();
      renderExceptions();
      renderFasah();
      renderSheets();
      renderItems();
      renderWarnings();
      renderReview();
      renderSaveState();
    }
    function renderTable() {
      var R = S.result, C = cols();
      var thead = $('ocr-match-thead'), tbody = $('ocr-match-tbody');
      thead.textContent = ''; tbody.textContent = '';
      var hr = el('tr');
      [T('m_col_field')].concat(C.map(docName)).concat([T('m_col_status'), T('m_col_conf'), T('m_col_reviewed')]).forEach(function (h) {
        var th = el('th', null, h); th.scope = 'col'; hr.appendChild(th);
      });
      thead.appendChild(hr);
      R.rows.forEach(function (row) { tbody.appendChild(rowEl(row, R, C)); });
    }
    // one table row (the cells are rebuilt in place by patchTable after a correction)
    function rowEl(row, R, C) {
        var tr = el('tr', 'ocr-match-row ' + STATUS_CLS[row.status]);
        tr.setAttribute('data-key', row.key);
        // match v2: a mismatch row pulses red, a partial one amber; a reviewed row keeps a static edge only
        var lvlRow = row.status === 'mismatch' ? 'bad' : row.status === 'partial' ? 'warn' : '';
        if (lvlRow) tr.classList.add('ocr-mx-r-' + lvlRow);
        if (lvlRow && S.reviewed[row.key]) tr.classList.add('is-reviewed');
        var th = el('th', 'ocr-match-field'); th.scope = 'row';
        th.appendChild(el('span', null, L(row, 'label')));
        if (row.critical) {
          var cr = el('span', 'ocr-match-crit', '★'); cr.title = T('m_critical');
          cr.setAttribute('aria-hidden', 'true'); th.appendChild(cr);
          th.appendChild(el('span', 'sr-only', ' (' + T('m_critical') + ')'));
        }
        if (correctedKeys(row)) th.appendChild(el('span', 'badge badge-sm badge-blue ocr-match-corr', T('m_corrected')));
        tr.appendChild(th);
        C.forEach(function (k) {
          var td = el('td', 'ocr-match-val');
          var v = row.values[k];
          var cl = cellLevel(row, k);
          if (cl) td.classList.add('ocr-mx-v-' + cl);
          var editable = row.src && row.src[k] && row.key !== 'items' && row.key !== 'invoice_totals';
          if (v === undefined) {
            td.appendChild(el('span', 'ocr-match-na', '—'));
          } else if (editable) {
            var inp = el('input', 'ocr-match-input-val');
            inp.type = 'text'; inp.value = v == null ? '' : v; inp.dir = 'auto'; inp.maxLength = 2000;
            inp.placeholder = T('m_not_read');
            inp.setAttribute('data-doc', k); inp.setAttribute('data-src', row.src[k]); inp.setAttribute('data-row', row.key);
            inp.setAttribute('aria-label', L(row, 'label') + ' — ' + docName(k));
            var f = S.slots[k].fields && S.slots[k].fields[row.src[k]];
            if (f && f.corrected) inp.classList.add('is-corrected');
            td.appendChild(inp);
            var pv = el('span', 'ocr-match-print-val', v == null ? '—' : v); pv.dir = 'auto';
            td.appendChild(pv);
          } else {
            var sv = el('span', null, v == null ? '—' : v); sv.dir = 'auto';
            td.appendChild(sv);
          }
          tr.appendChild(td);
        });
        var tdS = el('td', 'ocr-match-st');
        tdS.appendChild(el('span', 'ocr-match-chip ' + STATUS_CLS[row.status], T('m_st_' + row.status)));
        var det = L(row, 'detail');
        if (det) tdS.appendChild(el('span', 'ocr-match-detail', det));
        if (multi(R)) {
          var pw = el('span', 'ocr-match-pairs');
          Object.keys(PAIR_DOCS).forEach(function (p) {
            var ps = row.pairs && row.pairs[p];
            // a document that simply does not carry an optional field is not worth a chip
            if (!ps || (ps === 'missing' && row.status !== 'missing')) return;
            var chip = el('span', 'ocr-match-pair ' + (STATUS_CLS[ps] || ''));
            chip.title = T('m_pair_' + p) + ': ' + T('m_st_' + ps);
            var vis = el('span', null, T('m_pair_' + p) + ' ' + pairMark(ps)); vis.setAttribute('aria-hidden', 'true');
            chip.appendChild(vis);
            chip.appendChild(el('span', 'sr-only', chip.title));
            pw.appendChild(chip);
          });
          if (pw.childNodes.length) tdS.appendChild(pw);
        }
        tr.appendChild(tdS);
        var tdC = el('td', 'ocr-match-conf');
        var lows = C.filter(function (k) { return row.conf && row.conf[k] != null && row.conf[k] < LOW_CONF; });
        var vals = C.map(function (k) { return row.conf && row.conf[k]; }).filter(function (x) { return x != null; });
        if (vals.length) {
          var mn = Math.min.apply(null, vals);
          var cEl = el('span', 'ocr-match-confv' + (lows.length ? ' is-low' : ''));
          cEl.title = lows.length ? T('m_low_conf', { docs: lows.map(docName).join('، ') }) : T('m_conf_min');
          if (lows.length) { var wi = el('span', null, '⚠ '); wi.setAttribute('aria-hidden', 'true'); cEl.appendChild(wi); }
          cEl.appendChild(document.createTextNode(Math.round(mn * 100) + '%'));
          tdC.appendChild(cEl);
          // visible (also on touch screens, and read by screen readers): which reading is unsure
          if (lows.length) tdC.appendChild(el('span', 'ocr-match-detail', T('m_low_conf', { docs: lows.map(docName).join('، ') })));
        } else tdC.appendChild(el('span', 'ocr-match-na', '—'));
        tr.appendChild(tdC);
        var tdR = el('td', 'ocr-match-rev');
        var lab = el('label', 'check');
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!S.reviewed[row.key]; cb.setAttribute('data-review', row.key);
        cb.setAttribute('aria-label', T('m_reviewed_aria', { field: L(row, 'label') }));
        lab.appendChild(cb);
        lab.appendChild(el('span', 'ocr-match-print-val', cb.checked ? '✓' : ''));
        tdR.appendChild(lab);
        tr.appendChild(tdR);
        return tr;
    }
    // after a correction: same rows → update the cells around the inputs / checkboxes without replacing them, so the
    // focus (Tab) and a click that started on another input or a "reviewed" box are not lost; other rows → rebuild
    function patchTable() {
      var R = S.result, C = cols(), tbody = $('ocr-match-tbody');
      var trs = qsa('tr[data-key]', tbody);
      var same = trs.length === R.rows.length && R.rows.every(function (r, i) { return trs[i].getAttribute('data-key') === r.key; });
      if (!same) return false;
      R.rows.forEach(function (row, i) {
        var tr = trs[i], fresh = rowEl(row, R, C);
        tr.className = fresh.className;
        var oc = tr.children, nc = fresh.children;
        for (var j = 0; j < nc.length && j < oc.length; j++) {
          var keep = oc[j].querySelector('input');
          if (!keep) { tr.replaceChild(nc[j].cloneNode(true), oc[j]); continue; }
          oc[j].className = nc[j].className;
          // a cell with a control: keep the control, refresh its state and the printed copy
          var ni = nc[j].querySelector('input');
          if (keep.type === 'checkbox') keep.checked = !!(ni && ni.checked);
          else if (ni) {
            if (keep !== document.activeElement && keep.value !== ni.value) keep.value = ni.value;
            keep.classList.toggle('is-corrected', ni.classList.contains('is-corrected'));
          }
          var op = oc[j].querySelector('.ocr-match-print-val'), np = nc[j].querySelector('.ocr-match-print-val');
          if (op && np) op.textContent = np.textContent;
        }
      });
      return true;
    }
    function ctlKey(n) {
      if (!n || !n.getAttribute) return null;
      if (n.hasAttribute('data-review')) return 'input[data-review="' + n.getAttribute('data-review') + '"]';
      if (n.hasAttribute('data-row')) return 'input[data-row="' + n.getAttribute('data-row') + '"][data-doc="' + n.getAttribute('data-doc') + '"]';
      return null;
    }
    function pairMark(s) { return s === 'match' ? '✓' : s === 'mismatch' ? '✗' : s === 'partial' ? '≈' : '—'; }
    // reviewer correction → the reading's field (flagged) → recompute; the same input gets the focus back
    $('ocr-match-tbody').addEventListener('change', function (e) {
      var t = e.target;
      if (t.matches && t.matches('input[data-review]')) {
        var key = t.getAttribute('data-review');
        if (t.checked) S.reviewed[key] = true; else delete S.reviewed[key];
        var pv = t.parentNode.querySelector('.ocr-match-print-val'); if (pv) pv.textContent = t.checked ? '✓' : '';
        var rtr = t.closest ? t.closest('tr') : null;
        if (rtr) rtr.classList.toggle('is-reviewed', t.checked);
        renderExceptions(); renderSheets();
        if (S.approved) { S.approved = false; }
        renderReview();
        return;
      }
      if (!(t.matches && t.matches('input[data-src]'))) return;
      var k = t.getAttribute('data-doc'), src = t.getAttribute('data-src'), rowKey = t.getAttribute('data-row');
      var s = S.slots[k];
      if (!s.fields) return;
      var v = String(t.value || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 2000);
      var cur = s.fields[src] ? s.fields[src].value : null;
      if ((cur == null ? '' : String(cur)) === v) { enterKey = null; return; }       // nothing changed (e.g. Enter then blur)
      var orig = s.orig && Object.prototype.hasOwnProperty.call(s.orig, src) ? s.orig[src] : null;
      if (orig != null && v === orig) {
        s.fields[src] = { value: orig, score: s.fields[src] && s.fields[src].corrected ? s.fields[src].origScore : (s.fields[src] || {}).score };
      } else {
        var prev = s.fields[src];
        s.fields[src] = { value: v, score: 1, corrected: true, origScore: prev && !prev.corrected ? prev.score : (prev ? prev.origScore : null) };
      }
      delete S.reviewed[rowKey];
      S.approved = false;
      S.idem = null;
      if (S.saved.match) {
        // the saved match no longer reflects the table: the next save replaces it (the old one is voided then)
        if (S.saved.match.id) S.saved.prevMatch = S.saved.match.id;
        S.saved.match = null; setSaveMsg('warning', T('m_changed_after_save'));
      }
      recompute(false, true);
      // rows were added / removed (full rebuild): give the focus back to the control that had it, by its attributes
      if (!t.isConnected) {
        var sel = enterKey === t ? ctlKey(t) : null;
        setTimeout(function () {
          var want = sel || ctlKey(lastFocus) || ctlKey(t);
          var n = want && qsa('#ocr-match-tbody ' + want)[0];
          if (n && document.activeElement !== n && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) n.focus();
        }, 0);
      }
      enterKey = null;
      announce(T('m_recomputed', { overall: T('m_overall_' + S.result.overall) }));
    });
    // the control that gets the focus next (Tab / click) — restored after a full rebuild; Enter keeps the edited input
    var lastFocus = null, enterKey = null;
    $('ocr-match-tbody').addEventListener('focusin', function (e) { lastFocus = e.target; });
    $('ocr-match-tbody').addEventListener('keydown', function (e) {
      // Enter commits a text input (the browser fires 'change'): that input keeps the focus
      if (e.key === 'Enter' && e.target.matches && e.target.matches('input[data-src]')) enterKey = e.target;
    });
    function renderItems() {
      var R = S.result, it = R.items, box = $('ocr-match-items-box');
      var head = $('ocr-match-items-head'), body = $('ocr-match-items-body'), note = $('ocr-match-items-note');
      head.textContent = ''; body.textContent = ''; note.textContent = '';
      // the packing list's line items are not compared by the engine: no column for it here
      var C = cols().filter(function (k) { return k !== 'packing'; });
      var hr = el('tr');
      [T('m_item_hs'), T('m_item_desc')].concat(C.map(function (k) { return T('m_item_qty') + ' — ' + docName(k); })).concat([T('m_col_status')])
        .forEach(function (h) { var th = el('th', null, h); th.scope = 'col'; hr.appendChild(th); });
      head.appendChild(hr);
      var groups = it.groups.length ? it.groups : (it.invoice || []).map(function (x) {
        return { hs6: E.hs6Set(x.hs_code)[0] || '', description: x.description, quantity: { invoice: x.quantity }, status: null };
      });
      groups.forEach(function (g) {
        var tr = el('tr');
        tr.appendChild(el('td', 'num', g.hs6 || '—'));
        var dtd = el('td', null, g.description || '—'); dtd.dir = 'auto'; tr.appendChild(dtd);
        C.forEach(function (k) { var q = g.quantity ? g.quantity[k] : null; tr.appendChild(el('td', 'num', q == null ? '—' : E.fmtNum(q))); });
        var td = el('td');
        if (g.status) td.appendChild(el('span', 'ocr-match-chip ' + STATUS_CLS[g.status], T('m_st_' + g.status)));
        else td.textContent = '—';
        tr.appendChild(td);
        body.appendChild(tr);
      });
      var parts = [];
      if (it.totals) {
        parts.push(T('m_items_sum', { sum: E.fmtNum(it.totals.items_sum), ref: it.totals.reference == null ? '—' : E.fmtNum(it.totals.reference) }));
      }
      if (!it.groups.length && C.length > 1) parts.push(T('m_items_only_invoice'));
      note.textContent = parts.join(' ');
      box.hidden = !groups.length && !it.totals;
    }
    // server checks (extract.js W('server', code, English text, field)) → this page's language; model notes as written
    var SERVER_WARN = ['container_check_digit', 'hs_format', 'conflicting_values', 'vat_format', 'date_format', 'amount_format',
      'currency_format', 'iban_format', 'weight_format', 'weight_range', 'packages_format', 'packages_range', 'incoterms_format',
      'totals_mismatch', 'vat_rate', 'net_over_gross'];
    function warnText(w) {
      if (w.source !== 'server' || SERVER_WARN.indexOf(w.code) === -1) return w.text;
      var i = w.text.indexOf(': ');
      var val = (w.code === 'container_check_digit' || w.code === 'hs_format') && i !== -1 ? w.text.slice(i + 2) : '';
      return T('m_w_' + w.code) + (val ? ': ' + val : '');
    }
    var FIELD_NAMES = {};
    (E.FIELDS || []).forEach(function (f) { FIELD_NAMES[f.key] = f; });
    function fieldLabel(key) {
      var f = FIELD_NAMES[key];
      if (f) return lang() === 'en' ? f.label_en : f.label_ar;
      var k = 'ocr.f_' + key;
      if (I18N && typeof I18N.t === 'function' && I18N.has && I18N.has(k)) return I18N.t(k);
      return String(key);
    }
    function renderWarnings() {
      var ul = $('ocr-match-warn'); ul.textContent = '';
      var n = 0;
      cols().forEach(function (k) {
        var res = S.slots[k].res;
        (res && res.warnings || []).slice(0, 60).forEach(function (w) {
          if (!w || typeof w.text !== 'string') return;
          if (w.code === 'doc_type_mismatch') return;                 // shown localized on the slot and in the alerts
          if (w.source === 'server' && w.code === 'quick_reading') return;   // the slot's «قراءة سريعة» badge says it
          var li = el('li');
          li.appendChild(el('strong', null, docName(k) + ': '));
          li.appendChild(el('span', null, (w.field ? fieldLabel(w.field) + ' — ' : '') + warnText(w)));
          li.lastChild.dir = 'auto';
          ul.appendChild(li); n++;
        });
      });
      $('ocr-match-warn-count').textContent = n ? '(' + n + ')' : '';
      $('ocr-match-warn-box').hidden = !n;
    }
    /* ---------------------------------------------------------------
       match v2: per-document sheets + exceptions table + highlight levels
       bad  = a value that differs from another document, or one the server flagged invalid (red pulse)
       warn = partial match, low confidence, a server / model remark to review (amber pulse)
       miss = a field this document normally carries (and that matters) but the reading did not return (dashed)
       All values via textContent; a value with no Arabic letters is shown left-to-right (<bdi dir="ltr">).
       --------------------------------------------------------------- */
    // the reference sheet's order (البوليصة / الفاتورة التجارية / بيان التعبئة), then the declaration
    var SHEET_ORDER = ['bl', 'invoice', 'packing', 'declaration'];
    var LVL_RANK = { '': 0, miss: 1, warn: 2, bad: 3 };
    // server checks that mean "this value is not valid" (red); the other server checks are remarks to review (amber)
    var INVALID_WARN = ['container_check_digit', 'hs_format', 'vat_format', 'date_format', 'amount_format', 'currency_format',
      'iban_format', 'weight_format', 'packages_format', 'incoterms_format', 'seal_format'];
    // reading order of a sheet (the reference «ورقة معلومات الإدخال»); other keys follow in the reading's order
    var SHEET_KEYS = ['bl_number', 'booking_number', 'invoice_number', 'invoice_date', 'declaration_number', 'declaration_type',
      'declaration_status', 'declaration_date', 'declaration_date_hijri', 'shipper', 'supplier_name', 'supplier_vat', 'consignee',
      'consignee_name', 'buyer_name', 'buyer_vat', 'importer_name_ar', 'notify_party', 'broker_name', 'vessel', 'voyage', 'shipping_line',
      'port_of_loading', 'port_of_discharge', 'place_of_receipt', 'place_of_delivery', 'export_country', 'country_of_origin',
      'freight_terms', 'incoterms', 'payment_terms', 'payment_method', 'goods_description', 'packages_count', 'package_type',
      'net_weight', 'gross_weight', 'measurement_cbm', 'temperature_c', 'container_numbers', 'seal_numbers', 'hs_codes', 'currency',
      'subtotal', 'vat_amount', 'total', 'local_value', 'iban', 'packing_list_number', 'packing_list_date'];
    var WIDE_KEYS = ['goods_description'];          // and any value longer than 40 characters
    function mxHas(k) { return !!(I18N && typeof I18N.has === 'function' && I18N.has('ocr.' + k)); }
    function sheetLabel(key) {
      if (mxHas('mx_f_' + key)) return T('mx_f_' + key);
      if (mxHas('f_' + key)) return T('f_' + key);
      if (FIELD_NAMES[key]) return fieldLabel(key);
      var s = String(key).replace(/_/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    function isLtr(v) { return !/[؀-ۿ]/.test(String(v == null ? '' : v)); }
    function valNode(v, cls) {
      var b = el('bdi', cls || null, v);
      b.dir = isLtr(v) ? 'ltr' : 'auto';
      return b;
    }
    function hasVal(v) { return v != null && v !== ''; }
    function critOf(d, mode) { return d.critical === 'three' ? mode === 'three_way' : !!d.critical; }
    // the documents k is compared with in this row whose pair has status st
    function partners(row, k, st) {
      var out = [];
      Object.keys(PAIR_DOCS).forEach(function (p) {
        var d = PAIR_DOCS[p], i = d.indexOf(k);
        if (i !== -1 && row.pairs && row.pairs[p] === st) out.push(d[1 - i]);
      });
      return out;
    }
    function anyPair(row) { return !!(row.pairs && Object.keys(row.pairs).some(function (p) { return !!row.pairs[p]; })); }
    // level of document k's cell in a comparison row
    function cellLevel(row, k) {
      var v = row.values ? row.values[k] : undefined;
      if (v === undefined) return '';
      if (v == null || v === '') {
        var d = FIELD_NAMES[row.key];
        return row.status === 'missing' && d && d.exp.indexOf(k) !== -1 ? 'miss' : '';
      }
      if (row.status === 'mismatch') return partners(row, k, 'mismatch').length || !anyPair(row) ? 'bad' : '';
      if (row.status === 'partial') return partners(row, k, 'partial').length || partners(row, k, 'mismatch').length || !anyPair(row) ? 'warn' : '';
      return '';
    }
    function docsList(list) { return list.map(docName).join(lang() === 'en' ? ', ' : '، '); }
    // per document: { extraction key: {lvl, reasons[], row?, bad[] (invalid container numbers)} }
    function issuesOf(k) {
      var R = S.result, s = S.slots[k], out = {};
      function put(key, lvl, reason, extra) {
        // kind: 'row' (a comparison row), 'note' (a remark on the reading itself: stays until corrected)
        var o = out[key] || (out[key] = { lvl: '', reasons: {}, list: [], bad: [], rows: [], notes: 0 });
        var kind = extra && extra.row ? 'row' : 'note';
        if (LVL_RANK[lvl] > LVL_RANK[o.lvl]) o.lvl = lvl;
        if (reason && !o.reasons[lvl + '|' + reason]) { o.reasons[lvl + '|' + reason] = 1; o.list.push({ lvl: lvl, text: reason, kind: kind }); }
        if (extra && extra.bad) o.bad.push(extra.bad);
        if (extra && extra.row) { if (o.rows.indexOf(extra.row) === -1) o.rows.push(extra.row); }
        else if (lvl !== 'miss') o.notes++;
        return o;
      }
      if (!R || !s.res) return out;
      var fields = s.fields || {};
      // comparison rows
      R.rows.forEach(function (row) {
        var key = row.src && row.src[k];
        if (!key || row.key === 'items' || row.key === 'invoice_totals') return;
        var lvl = cellLevel(row, k);
        if (!lvl) return;
        var reason;
        if (lvl === 'bad') {
          var pm = partners(row, k, 'mismatch');
          reason = pm.length ? T('mx_badge_diff', { docs: docsList(pm) }) : T('mx_badge_diff_any');
        } else if (lvl === 'warn') {
          var pp = partners(row, k, 'partial');
          reason = pp.length ? T('mx_badge_partial', { docs: docsList(pp) }) : T('mx_badge_review');
        } else {
          reason = T('mx_not_read');
        }
        put(key, lvl, reason, { row: row.key });
      });
      // server / model remarks about a field (not for a value the reviewer corrected)
      (s.res.warnings || []).slice(0, 60).forEach(function (w) {
        if (!w || typeof w.text !== 'string' || !w.field || w.code === 'doc_type_mismatch') return;
        var key = w.field === 'containers' ? 'container_numbers' : String(w.field);
        if (!/^[a-z_]{2,40}$/.test(key)) return;
        if (fields[key] && fields[key].corrected) return;
        var bad = w.source === 'server' && INVALID_WARN.indexOf(w.code) !== -1;
        var extra = null;
        if (w.code === 'container_check_digit') {
          var i = w.text.indexOf(': ');
          var c = i !== -1 ? w.text.slice(i + 2).trim().slice(0, 20) : '';
          extra = c ? { bad: c } : null;
          put(key, 'bad', T('mx_bad_container'), extra);   // the number itself is shown as a struck chip
          return;
        }
        put(key, bad ? 'bad' : 'warn', warnText(w), extra);
      });
      // the reading's own validity flag + low confidence
      (s.res.fields || []).forEach(function (f) {
        if (!f || typeof f.name !== 'string' || !fields[f.name] || fields[f.name].corrected) return;
        if (f.valid === false) {
          var o = out[f.name];
          if (!o || !o.list.some(function (x) { return x.kind === 'note' && x.lvl === 'bad'; })) put(f.name, 'bad', T('mx_badge_invalid'));
        }
      });
      Object.keys(fields).forEach(function (key) {
        var f = fields[key];
        if (f && !f.corrected && f.score != null && f.score < LOW_CONF && hasVal(f.value)) {
          put(key, 'warn', T('mx_badge_lowconf', { n: Math.round(f.score * 100) }));
        }
      });
      // a field that matters, normally on this document, that the reading did not return
      (E.FIELDS || []).forEach(function (d) {
        var keys = d.keys && d.keys[k];
        if (!keys || d.exp.indexOf(k) === -1) return;
        if (keys.some(function (x) { return fields[x] && hasVal(fields[x].value); })) return;
        var row = R.rows.filter(function (r) { return r.key === d.key; })[0];
        var rowMissing = row && row.status === 'missing' && row.values[k] == null;
        if (!critOf(d, R.mode) && !rowMissing) return;
        put(keys[0], 'miss', T('mx_not_read'), row ? { row: row.key } : null).expected = true;
      });
      // every row of the field ticked as reviewed, and no remark on the reading itself: a static edge only
      Object.keys(out).forEach(function (key) {
        var o = out[key];
        o.calm = o.rows.length > 0 && !o.notes && o.rows.every(function (r) { return !!S.reviewed[r]; });
      });
      return out;
    }
    function lvlCls(base, o) {
      if (!o || !o.lvl) return base;
      return base + ' is-' + o.lvl + (o.calm ? ' is-calm' : '');
    }
    function topReason(o) { return o.list.filter(function (x) { return x.lvl === o.lvl; })[0] || o.list[0] || null; }
    function badge(o) {
      var top = topReason(o);
      var b = el('span', 'ocr-mx-badge is-' + o.lvl + (o.calm ? ' is-calm' : ''));
      var dot = el('span', 'ocr-mx-dot'); dot.setAttribute('aria-hidden', 'true');
      b.appendChild(dot);
      var t = el('span', null, top ? top.text : ''); t.dir = 'auto';
      b.appendChild(t);
      return b;
    }

    /* the sheets: one card per document read */
    function renderSheets() {
      var box = $('ocr-mx-sheets'), blk = $('ocr-mx-sheets-block');
      if (!box || !blk) return;
      box.textContent = '';
      var R = S.result;
      var docs = SHEET_ORDER.filter(function (k) { return R && R.documents.indexOf(k) !== -1 && S.slots[k].res; });
      blk.hidden = !docs.length;
      docs.forEach(function (k, n) { box.appendChild(sheetCard(k, n + 1)); });
    }
    function sheetCard(k, n) {
      var s = S.slots[k], res = s.res || {}, fields = s.fields || {};
      var iss = issuesOf(k);
      var meta = {};
      (res.fields || []).forEach(function (f) { if (f && typeof f.name === 'string') meta[f.name] = f; });
      // keys: the reading's fields (known order first), then the expected ones it did not return
      var keys = Object.keys(fields).filter(function (x) { return fields[x] && hasVal(fields[x].value); });
      var rest = keys.filter(function (x) { return SHEET_KEYS.indexOf(x) === -1; });
      keys = SHEET_KEYS.filter(function (x) { return keys.indexOf(x) !== -1; }).concat(rest);
      // the document's own number first
      var lead = { bl: 'bl_number', invoice: 'invoice_number', declaration: 'declaration_number', packing: 'packing_list_number' }[k];
      if (keys.indexOf(lead) > 0) { keys.splice(keys.indexOf(lead), 1); keys.unshift(lead); }
      Object.keys(iss).forEach(function (x) {
        if (keys.indexOf(x) === -1 && (iss[x].lvl === 'miss' || iss[x].bad.length)) keys.push(x);
      });
      var nBad = 0, nWarn = 0, nMiss = 0;
      keys.forEach(function (x) { var o = iss[x]; if (o) { if (o.lvl === 'bad') nBad++; else if (o.lvl === 'warn') nWarn++; else if (o.lvl === 'miss') nMiss++; } });
      var card = el('section', 'ocr-mx-sheet' + (nBad ? ' has-bad' : nWarn ? ' has-warn' : ''));
      card.setAttribute('data-doc', k);
      var hid = 'ocr-mx-sheet-h-' + k;
      card.setAttribute('aria-labelledby', hid);
      var head = el('div', 'ocr-mx-sheet-head');
      var h = el('h5', 'ocr-mx-sheet-title', T('mx_sheet_num', { n: n, title: T('mx_sheet_' + k) })); h.id = hid;
      head.appendChild(h);
      var sub = el('div', 'ocr-mx-sheet-sub');
      if (slotLabel(k)) sub.appendChild(valNode(slotLabel(k), 'ocr-mx-fname'));
      if (res.mean_confidence != null) sub.appendChild(el('span', null, T('ai_conf', { n: Math.round(Number(res.mean_confidence)) })));
      sub.appendChild(el('span', null, T('mx_sheet_fields', { n: Object.keys(fields).filter(function (x) { return fields[x] && hasVal(fields[x].value); }).length })));
      if (nBad) sub.appendChild(el('span', 'ocr-mx-count is-bad', T('mx_sheet_n_bad', { n: nBad })));
      if (nWarn) sub.appendChild(el('span', 'ocr-mx-count is-warn', T('mx_sheet_n_warn', { n: nWarn })));
      if (nMiss) sub.appendChild(el('span', 'ocr-mx-count is-miss', T('mx_sheet_n_miss', { n: nMiss })));
      head.appendChild(sub);
      card.appendChild(head);
      if (!keys.length) { card.appendChild(el('p', 'text-sm text-muted', T('mx_sheet_empty'))); return card; }
      var grid = el('dl', 'ocr-mx-grid');
      keys.forEach(function (key) {
        var f = fields[key], o = iss[key], v = f && hasVal(f.value) ? String(f.value) : '';
        var cell = el('div', lvlCls('ocr-mx-cell', o));
        cell.id = 'ocr-mx-c-' + k + '-' + key;
        cell.setAttribute('tabindex', '-1');
        if (WIDE_KEYS.indexOf(key) !== -1 || v.length > 40 || (iss[key] && iss[key].bad.length > 2)) cell.classList.add('is-wide');
        var dt = el('dt', 'ocr-mx-label', sheetLabel(key));
        var crit = FIELD_NAMES[key] && critOf(FIELD_NAMES[key], S.result.mode);
        if (crit) { var cr = el('span', 'ocr-match-crit', '★'); cr.setAttribute('aria-hidden', 'true'); cr.title = T('m_critical'); dt.appendChild(cr); }
        cell.appendChild(dt);
        var dd = el('dd', 'ocr-mx-value');
        if (key === 'container_numbers') containersInto(dd, v, o, k);
        else if (v) dd.appendChild(valNode(v));
        else dd.appendChild(el('span', 'ocr-mx-none', T('mx_not_read')));
        cell.appendChild(dd);
        if (o && o.lvl && (o.lvl !== 'miss' || v)) {
          cell.appendChild(badge(o));
          // the other remarks, visible (touch screens have no tooltip)
          var top = topReason(o);
          o.list.forEach(function (x) {
            if (x === top || x.lvl === 'miss') return;
            var w = el('span', 'ocr-mx-why is-' + x.lvl, x.text); w.dir = 'auto'; cell.appendChild(w);
          });
        } else if (o && o.lvl === 'miss') {
          cell.appendChild(el('span', 'ocr-mx-why is-miss', T('mx_expected')));
        }
        // page / confidence hint (a corrected value says so)
        if (f && hasVal(f.value)) {
          var hint = [];
          if (f.corrected) hint.push(T('m_corrected'));
          else {
            var m = meta[key];
            if (m && m.page != null && isFinite(Number(m.page))) hint.push(T('mx_hint_page', { p: Number(m.page) }));
            if (f.score != null) hint.push(T('mx_hint_conf', { n: Math.round(f.score * 100) }));
          }
          if (hint.length) cell.appendChild(el('span', 'ocr-mx-hint' + (f.corrected ? ' is-corrected' : ''), hint.join(' · ')));
        }
        grid.appendChild(cell);
      });
      card.appendChild(grid);
      // per-container rows when the reading has them (prompt ai-doc-v3)
      var ct = Array.isArray(res.containers) ? res.containers.filter(function (c) { return c && typeof c.container_number === 'string'; }).slice(0, 100) : [];
      if (ct.length) card.appendChild(containerTable(ct));
      return card;
    }
    function containersInto(dd, v, o, k) {
      var list = v ? E.containerSet(v) : [];
      if (v && !list.length) list = [v];
      var wrap = el('span', 'ocr-mx-chips');
      list.forEach(function (c) { var ch = valNode(c, 'ocr-mx-chip'); wrap.appendChild(ch); });
      (o && o.bad || []).forEach(function (c) {
        var ch = el('span', 'ocr-mx-chip is-bad');
        var x = el('span', null, '✗ '); x.setAttribute('aria-hidden', 'true'); ch.appendChild(x);
        ch.appendChild(valNode(c));
        ch.appendChild(el('span', 'sr-only', ' — ' + T('mx_bad_container')));
        ch.title = T('mx_bad_container');
        wrap.appendChild(ch);
      });
      if (wrap.childNodes.length) dd.appendChild(wrap);
      else dd.appendChild(el('span', 'ocr-mx-none', T('mx_not_read')));
    }
    function containerTable(ct) {
      var w = el('div', 'table-wrap ocr-mx-ct-wrap');
      var t = el('table', 'table ocr-mx-ct'), th = el('thead'), hr = el('tr'), tb = el('tbody');
      ['mx_ct_no', 'mx_ct_seal', 'mx_ct_size', 'mx_ct_pkgs', 'mx_ct_gross'].forEach(function (x) { var c = el('th', null, T(x)); c.scope = 'col'; hr.appendChild(c); });
      th.appendChild(hr); t.appendChild(th);
      ct.forEach(function (c) {
        var tr = el('tr');
        [c.container_number, c.seal_number, c.size_type, c.packages_count, c.gross_weight].forEach(function (x) {
          var td = el('td', 'num');
          td.appendChild(x == null || x === '' ? el('span', 'ocr-match-na', '—') : valNode(typeof x === 'number' ? E.fmtNum(x) : String(x)));
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb); w.appendChild(t);
      return w;
    }

    /* «كشف إدخال فسح» (2026-11-14, owner: the program PRODUCES the sheet from the B/L + the commercial invoice read
       together): MarsaFasahSheet.renderDraft (ops/fasah-sheet.js) from the readings of this report — the current
       (corrected) values, items and container rows, the SAME engine result (strict) for the common values and the
       exceptions table rows for the conflicts. Shown once the invoice and the B/L were both read; rebuilt with every
       render (a correction in the comparison table flows in). A reading that is itself a Fasah entry sheet or of an
       unknown type ('other') is left out, with a note. Exports logged first (fasah_sheet, filters {}). */
    function fasahDocs() {
      var R = S.result, out = {};
      SHEET_ORDER.forEach(function (k) {
        var s = S.slots[k], res = s.res;
        if (!res || R.documents.indexOf(k) === -1) return;
        out[k] = { fields: plainFields(s), items: (s.items || []).slice(0, 500), containers: Array.isArray(res.containers) ? res.containers.slice(0, 300) : [],
          label: slotLabel(k), fileName: s.fileName || (s.file ? s.file.name : ''),
          detected: typeof res.detected_type === 'string' ? res.detected_type : '',
          parentDetected: typeof res.source_detected_type === 'string' ? res.source_detected_type : '' };
      });
      return out;
    }
    function renderFasah() {
      var blk = $('ocr-fsh-block'), body = $('ocr-fsh-body'), F = window.MarsaFasahSheet;
      if (!blk || !body) return;
      var R = S.result;
      if (!R || !F || typeof F.renderDraft !== 'function' || !S.slots.invoice.res || !S.slots.bl.res
        || R.documents.indexOf('invoice') === -1 || R.documents.indexOf('bl') === -1) { body.textContent = ''; blk.hidden = true; return; }
      var X2 = exceptionRows();
      var m = F.renderDraft(body, {
        docs: fasahDocs(), result: R, lang: lang(), now: new Date(),
        exceptions: X2.rows.map(function (x) { return { st: x.st, label: x.label, values: x.values, note: x.note }; })
      }, { api: API, orgId: S.orgId || undefined, docName: docName });
      blk.hidden = false;
      blk.classList.toggle('is-ready', !!(m && m.ready));
    }
    /* exceptions: mismatch / partial / missing key field rows + invalid values; a row leads to its field */
    function exceptionRows() {
      var R = S.result, out = [], more = 0;
      R.rows.forEach(function (row) {
        if (row.status === 'mismatch' || row.status === 'partial' || (row.status === 'missing' && row.critical)) {
          out.push({ st: row.status, label: L(row, 'label'), values: row.values, note: L(row, 'detail') || '', target: 'row', key: row.key,
            reviewed: !!S.reviewed[row.key], critical: !!row.critical, row: row });
        } else if (row.status === 'missing') more++;
      });
      // key fields with no row at all (no document returned them)
      (E.FIELDS || []).forEach(function (d) {
        if (!critOf(d, R.mode) || R.rows.some(function (r) { return r.key === d.key; })) return;
        var valOf = function (k) {
          var fs = S.slots[k].fields || {}, hit = (d.keys[k] || []).filter(function (x) { return fs[x] && hasVal(fs[x].value); })[0];
          return hit ? String(fs[hit].value) : null;
        };
        var exp = R.documents.filter(function (k) { return d.keys[k] && d.exp.indexOf(k) !== -1 && valOf(k) == null; });
        if (!exp.length) return;
        var vals = {};
        R.documents.forEach(function (k) { vals[k] = d.keys[k] ? valOf(k) : undefined; });
        out.push({ st: 'missing', label: lang() === 'en' ? d.label_en : d.label_ar, values: vals, note: T('mx_note_missing', { docs: docsList(exp) }),
          target: 'cell', doc: exp[0], key: d.keys[exp[0]][0], critical: true });
      });
      // values a reading flagged invalid (e.g. a container number failing the ISO 6346 check digit)
      SHEET_ORDER.forEach(function (k) {
        if (R.documents.indexOf(k) === -1 || !S.slots[k].res) return;
        var iss = issuesOf(k);
        Object.keys(iss).forEach(function (key) {
          var o = iss[key];
          var inv = o.list.filter(function (x) { return x.lvl === 'bad' && x.kind === 'note'; });
          if (!inv.length) return;
          var vals = {}, f = S.slots[k].fields && S.slots[k].fields[key];
          R.documents.forEach(function (d) { vals[d] = d === k ? (f && hasVal(f.value) ? f.value : (o.bad.join(', ') || null)) : undefined; });
          if (key === 'container_numbers' && o.bad.length) vals[k] = o.bad.join(', ');
          out.push({ st: 'invalid', label: sheetLabel(key), values: vals, note: inv.map(function (x) { return x.text; }).join('؛ '), target: 'cell', doc: k, key: key });
        });
      });
      var rank = { invalid: 0, mismatch: 1, missing: 2, partial: 3 };
      out.sort(function (a, b) { return (rank[a.st] - rank[b.st]) || ((b.critical ? 1 : 0) - (a.critical ? 1 : 0)); });
      return { rows: out, more: more };
    }
    var EXC_ICON = { mismatch: '✗', partial: '≈', missing: '?', invalid: '!' };
    var EXC_CLS = { mismatch: 'is-mismatch', partial: 'is-partial', missing: 'is-missing', invalid: 'is-mismatch' };
    /* errors-only summary, the first block of the report: rows with status 'mismatch' + values a reading flagged
       invalid (e.g. a container number failing the ISO 6346 check digit). Never partial / missing / info (they stay in
       the exceptions table, counted in one quiet line); letter case / spacing differences are 'match' in the engine
       (doc-match.js looseKey), so they never get here. A line leads to its comparison-table row (or the sheet cell of
       an invalid value) and flashes it; a reviewed row's line is shown as reviewed. Rebuilt with the exceptions. */
    function isError(x) { return x.st === 'mismatch' || x.st === 'invalid'; }
    function renderSummary() {
      var box = $('ocr-mx-sum'), list = $('ocr-mx-sum-list');
      if (!box || !list || !S.result) return;
      var C = cols(), X2 = exceptionRows();
      var errs = X2.rows.filter(isError);
      var rest = X2.rows.filter(function (x) { return !isError(x); }).length;
      errs.forEach(function (x) { if (x.st === 'invalid') x.reviewed = !!S.reviewed[x.key]; });
      var nRev = errs.filter(function (x) { return x.reviewed; }).length, nOpen = errs.length - nRev;
      S.errOpen = nOpen;
      box.className = 'ocr-mx-sum ' + (!errs.length ? 'is-ok' : (nOpen ? 'is-bad' : 'is-done'));
      $('ocr-mx-sum-title').textContent = T('mx_sum_title', { n: errs.length });
      var stEl = $('ocr-mx-sum-state');
      stEl.textContent = nRev ? T('mx_sum_open', { n: nOpen }) + ' · ' + T('mx_sum_reviewed_n', { n: nRev }) : '';
      stEl.hidden = !nRev;
      $('ocr-mx-sum-ok').hidden = errs.length > 0;
      $('ocr-mx-sum-hint').hidden = !errs.length;
      list.textContent = '';
      list.hidden = !errs.length;
      errs.forEach(function (x) {
        var li = el('li', 'ocr-mx-sum-li');
        var b = el('button', 'ocr-mx-sum-item ' + (x.st === 'invalid' ? 'is-invalid' : 'is-mismatch') + (x.reviewed ? ' is-reviewed' : ''));
        b.type = 'button';
        b.setAttribute('data-target', x.target);
        b.setAttribute('data-key', x.key);
        if (x.doc) b.setAttribute('data-doc', x.doc);
        var ic = el('span', 'ocr-mx-sum-icon', x.reviewed ? '✓' : (x.st === 'invalid' ? '!' : '✗'));
        ic.setAttribute('aria-hidden', 'true');
        b.appendChild(ic);
        var main = el('span', 'ocr-mx-sum-main');
        var top = el('span', 'ocr-mx-sum-top');
        top.appendChild(el('span', 'ocr-mx-sum-label', x.label));
        if (x.critical) { var cr = el('span', 'ocr-match-crit', '★'); cr.setAttribute('aria-hidden', 'true'); top.appendChild(cr); }
        top.appendChild(el('span', 'ocr-mx-sum-kind', T('mx_st_' + x.st)));
        if (x.reviewed) top.appendChild(el('span', 'ocr-mx-sum-rev', '✓ ' + T('mx_reviewed')));
        main.appendChild(top);
        var vals = el('span', 'ocr-mx-sum-vals');
        C.forEach(function (k) {
          var v = x.values ? x.values[k] : undefined;
          if (v === undefined || ((v == null || v === '') && x.row)) return;   // a document without the value is not one of the differing values
          var lv = x.row ? cellLevel(x.row, k) : (x.doc === k ? 'bad' : '');
          var it = el('span', 'ocr-mx-sum-val' + (lv === 'bad' ? ' is-bad' : ''));
          it.appendChild(el('span', 'ocr-mx-sum-doc', docName(k) + ': '));
          if (v == null || v === '') it.appendChild(el('span', 'ocr-mx-none', T('mx_sum_none_read')));
          else it.appendChild(valNode(String(v)));
          vals.appendChild(it);
        });
        main.appendChild(vals);
        var why = el('span', 'ocr-mx-sum-why', x.note || T('mx_st_' + x.st));
        why.dir = 'auto';
        main.appendChild(why);
        b.appendChild(main);
        b.setAttribute('aria-label', x.label + ' — ' + T('mx_st_' + x.st) + (x.reviewed ? ' (' + T('mx_reviewed') + ')' : '') + '. '
          + (x.note || '') + ' ' + T('mx_sum_go'));
        li.appendChild(b);
        list.appendChild(li);
      });
      var q = $('ocr-mx-sum-quiet');
      $('ocr-mx-sum-review').textContent = rest === 1 ? T('mx_sum_review_1') : T('mx_sum_review', { n: rest });
      q.hidden = !rest;
    }
    (function () {
      var list = $('ocr-mx-sum-list'), more = $('ocr-mx-sum-review');
      if (list) list.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-target]') : null;
        if (b) goException(b);
      });
      if (more) more.addEventListener('click', function () { flash($('ocr-mx-exc')); });
    })();
    function renderExceptions() {
      renderSummary();
      var head = $('ocr-mx-exc-head'), body = $('ocr-mx-exc-body');
      if (!head || !body || !S.result) return;
      head.textContent = ''; body.textContent = '';
      var C = cols(), X2 = exceptionRows(), list = X2.rows;
      $('ocr-mx-exc-ok').hidden = list.length > 0;
      $('ocr-mx-exc-wrap').hidden = !list.length;
      $('ocr-mx-exc-hint').hidden = !list.length;
      var more = $('ocr-mx-exc-more');
      more.textContent = X2.more ? T('mx_exc_more', { n: X2.more }) : '';
      more.hidden = !X2.more;
      if (!list.length) return;
      var hr = el('tr');
      [T('mx_col_state'), T('m_col_field')].concat(C.map(docName)).concat([T('mx_col_note')]).forEach(function (h) {
        var th = el('th', null, h); th.scope = 'col'; hr.appendChild(th);
      });
      head.appendChild(hr);
      list.forEach(function (x) {
        var tr = el('tr', 'ocr-mx-exc-row ' + EXC_CLS[x.st] + (x.reviewed ? ' is-reviewed' : ''));
        tr.tabIndex = 0;
        tr.setAttribute('data-target', x.target);
        tr.setAttribute('data-key', x.key);
        if (x.doc) tr.setAttribute('data-doc', x.doc);
        var tdS = el('td', 'ocr-mx-exc-st');
        var chip = el('span', 'ocr-match-chip ' + EXC_CLS[x.st]);
        var ic = el('span', 'ocr-mx-exc-icon', EXC_ICON[x.st] + ' '); ic.setAttribute('aria-hidden', 'true');
        chip.appendChild(ic);
        chip.appendChild(document.createTextNode(T('mx_st_' + x.st)));
        tdS.appendChild(chip);
        if (x.reviewed) tdS.appendChild(el('span', 'ocr-mx-exc-rev', '✓ ' + T('mx_reviewed')));
        tr.appendChild(tdS);
        var th = el('th', 'ocr-mx-exc-field', x.label); th.scope = 'row';
        if (x.critical) { var cr = el('span', 'ocr-match-crit', '★'); cr.setAttribute('aria-hidden', 'true'); th.appendChild(cr); }
        tr.appendChild(th);
        C.forEach(function (k) {
          var td = el('td', 'ocr-mx-exc-val'), v = x.values ? x.values[k] : undefined;
          var lv = x.row ? cellLevel(x.row, k) : (x.st === 'invalid' && x.doc === k ? 'bad' : (x.st === 'missing' && v === null ? 'miss' : ''));
          if (lv) td.classList.add('ocr-mx-v-' + lv);
          if (v === undefined) td.appendChild(el('span', 'ocr-match-na', '—'));
          else if (v == null || v === '') td.appendChild(el('span', 'ocr-mx-none', T('mx_not_read')));
          else td.appendChild(valNode(String(v)));
          tr.appendChild(td);
        });
        var tdN = el('td', 'ocr-mx-exc-note', x.note || '—'); tdN.dir = 'auto';
        tr.appendChild(tdN);
        tr.setAttribute('aria-label', x.label + ' — ' + T('mx_st_' + x.st) + '. ' + T('mx_exc_go'));
        body.appendChild(tr);
      });
    }
    // after a comparison: with open errors the page scrolls down to «ملخص الأخطاء» by itself (below the fixed site
    // header), otherwise to the top of the report; the focus follows without a second jump. Run a moment later so it
    // wins over the reader's own focus on its result (ocr.js showResult runs just before).
    function revealReport() {
      setTimeout(function () {
        var sum = $('ocr-mx-sum'), target = (S && S.errOpen > 0 && sum) ? sum : ($('ocr-match-report') || $('ocr-match-result'));
        if (!target) return;
        var hdr = document.querySelector('.site-header, header');
        var off = (hdr && hdr.getBoundingClientRect().height || 72) + 16;
        var y = target.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - off;
        try { window.scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { window.scrollTo(0, Math.max(0, y)); }
        var f = sum || $('ocr-match-banner');
        if (f) { try { f.focus({ preventScroll: true }); } catch (e) { /* noop */ } }
      }, 80);
    }
    function reducedMotion() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
    function flash(n) {
      if (!n) return;
      try { n.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { n.scrollIntoView(); }
      n.classList.remove('ocr-mx-flash');
      void n.offsetWidth;                      // restart the animation
      n.classList.add('ocr-mx-flash');
      setTimeout(function () { n.classList.remove('ocr-mx-flash'); }, 2600);
      var f = n.querySelector('input[data-src]') || n;
      if (f === n && !n.hasAttribute('tabindex')) n.setAttribute('tabindex', '-1');
      try { f.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    }
    function goException(tr) {
      if (!tr) return;
      var key = tr.getAttribute('data-key'), n = null;
      if (tr.getAttribute('data-target') === 'row') {
        n = qsa('#ocr-match-tbody tr[data-key="' + key + '"]')[0] || null;
      } else {
        n = $('ocr-mx-c-' + tr.getAttribute('data-doc') + '-' + key);
      }
      flash(n);
    }
    (function () {
      var b = $('ocr-mx-exc-body');
      if (!b) return;
      b.addEventListener('click', function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-target]') : null;
        if (tr) goException(tr);
      });
      b.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        var tr = e.target && e.target.matches && e.target.matches('tr[data-target]') ? e.target : null;
        if (!tr) return;
        e.preventDefault();
        goException(tr);
      });
    })();

    function reviewedRows() { return S.result ? S.result.rows.filter(function (r) { return S.reviewed[r.key]; }).map(function (r) { return r.key; }) : []; }
    function renderReview() {
      $('ocr-match-reviewer').value = reviewerName();
      var n = reviewedRows().length, total = S.result ? S.result.rows.length : 0;
      var st = $('ocr-match-review-state');
      var savedReviewed = S.saved.match && S.saved.match.status === 'reviewed';
      st.textContent = (S.approved || savedReviewed ? T('m_review_approved') : T('m_review_pending')) + ' · ' + T('m_reviewed_n', { n: n, total: total });
      st.className = 'ocr-match-review-state ' + (S.approved || savedReviewed ? 'is-match' : 'is-missing');
    }
    $('ocr-match-tick-all').addEventListener('click', function () {
      if (!S.result) return;
      S.result.rows.forEach(function (r) { S.reviewed[r.key] = true; });
      renderTable(); renderExceptions(); renderSheets(); renderReview();
      announce(T('m_reviewed_n', { n: S.result.rows.length, total: S.result.rows.length }));
    });
    $('ocr-match-approve').addEventListener('click', function () {
      if (!S.result) return;
      var btn = this;
      // the reviewer ticks what was checked (or «تحديد الكل»): nothing is ticked on their behalf
      if (!reviewedRows().length) {
        var st = $('ocr-match-review-state');
        st.textContent = T('m_review_need_tick'); st.className = 'ocr-match-review-state is-partial';
        announce(T('m_review_need_tick'));
        return;
      }
      S.approved = true;
      renderReview();
      if (S.saved.match && S.saved.match.id && has('reviewDocumentMatch')) {
        setSaveMsg('info', T('m_saving'));
        btn.disabled = true;
        var id = S.saved.match.id;
        API.reviewDocumentMatch(id, reviewedRows(), savedNote()).then(function (r) {
          if (r.error) { setSaveMsg('error', T('m_save_failed', { msg: errMsg(r.error) })); return; }
          if (S.saved.match && S.saved.match.id === id) S.saved.match.status = (r.data && r.data.status) || 'reviewed';
          setSaveMsg('success', T('m_review_saved'));
          renderReview(); loadRecent();
        }).catch(function (e) {
          setSaveMsg('error', T('m_save_failed', { msg: errMsg(e) }));
        }).then(function () { btn.disabled = false; });
      } else {
        toast(T('m_review_local'), 'info');
      }
    });
    function noteText() { return String($('ocr-match-note-text').value || '').trim().slice(0, 1000); }
    // the saved note: the reviewer's note + one line with the check level (save_document_match has no field for it;
    // its rows / keys are fixed, the note is free text ≤ 1000)
    function savedNote() {
      var tag = S.result && S.result.check_mode ? '[' + T('mx_check_meta') + ': ' + checkText(S.result.check_mode) + ']' : '';
      var n = noteText();
      if (!tag) return n;
      return (n ? n.slice(0, 1000 - tag.length - 1) + '\n' : '') + tag;
    }

    /* ---------------------------------------------------------------
       Save in the system
       --------------------------------------------------------------- */
    function setSaveMsg(type, text) {
      var box = $('ocr-match-save-msg');
      box.className = 'alert mt-2 alert-' + (type === 'error' ? 'danger' : type === 'success' ? 'success' : type === 'warning' ? 'warning' : 'info');
      $('ocr-match-save-msg-text').textContent = text || '';
      box.hidden = !text;
    }
    // the saved row of a reading the single reader already saved ({id, doc_type, transaction_id, document_id}) or null
    function savedOf(k) {
      var r = S.slots[k].savedRef;
      if (typeof r === 'function') { try { r = r(); } catch (e) { r = null; } }
      return r && typeof r === 'object' && UUID_RE.test(String(r.id || '')) ? r : null;
    }
    // why this report cannot be saved as a match (null = it can): a part of a combined file is not a reading of its own
    // (one AI reading = one saved extraction, ai_usage_id is unique), the match needs the invoice and the B/L, a reading
    // saved as another kind of document cannot fill this slot, and an unsaved reading needs its file + hash + usage id
    function saveBlock() {
      var R = S.result;
      if (!R) return null;
      var docs = R.documents.filter(function (k) { return S.slots[k].res; });
      var parts = docs.filter(function (k) { return S.slots[k].part; });
      if (parts.length) return T('mx_save_block_part', { docs: docsList(parts) });
      if (docs.indexOf('invoice') === -1 || docs.indexOf('bl') === -1) return T('mx_save_block_need');
      var ids = {};
      for (var i = 0; i < docs.length; i++) {
        var k = docs[i], s = S.slots[k], ref = savedOf(k);
        if (!s.bridged) continue;
        if (ref && ref.doc_type && ref.doc_type !== DOC_TYPE[k]) return T('mx_save_block_kind', { doc: docName(k), kind: kindName(ref.doc_type) });
        var stored = !ref && s.res && s.res.reused && UUID_RE.test(String(s.res.extraction_id || ''));
        var sk = stored ? s.res.kind || s.res.doc_type : null;
        if (sk && sk !== DOC_TYPE[k]) return T('mx_save_block_kind', { doc: docName(k), kind: kindName(sk) });
        if (!ref && !stored && (!s.file || !/^[0-9a-f]{64}$/.test(s.sha256 || '') || !(s.res && s.res.usage_id))) return T('mx_save_block_unsaved', { doc: docName(k) });
        // one saved reading cannot fill two slots of a match (save_document_match needs distinct extractions)
        var id = ref ? String(ref.id) : stored ? String(s.res.extraction_id) : '';
        if (id) { id = id.toLowerCase(); if (ids[id]) return T('mx_save_block_same', { a: docName(ids[id]), b: docName(k) }); ids[id] = k; }
      }
      return null;
    }
    function renderSaveState() {
      var done = !!(S.saved.match && S.saved.match.id);
      var block = done ? null : saveBlock();
      var bn = $('ocr-match-save-block');
      if (bn) { $('ocr-match-save-block-text').textContent = block || ''; bn.hidden = !block; }
      $('ocr-match-save-label').textContent = done ? T('m_saved_label') : T('m_save');
      $('ocr-match-save-btn').disabled = done || S.saving || !!block;
      var anyExt = Object.keys(S.saved.extractions).length > 0;
      $('ocr-match-tx').disabled = $('ocr-match-tx-q').disabled = $('ocr-match-tx-search').disabled = done || anyExt;
      $('ocr-match-attach').disabled = done || anyExt;
    }
    function plainFields(s) {
      var o = {};
      Object.keys(s.fields || {}).forEach(function (k) { var v = s.fields[k] && s.fields[k].value; if (typeof v === 'string' && v) o[k] = v; });
      return o;
    }
    function extractionRow(k, txId, attach) {
      var s = S.slots[k], res = s.res || {};
      var maxPage = 0;
      (res.fields || []).forEach(function (f) { if (f && f.page > maxPage) maxPage = f.page; });
      var row = {
        doc_type: DOC_TYPE[k], source_name: String(s.file ? s.file.name : docName(k)).slice(0, 255), source_sha256: s.sha256 || '',
        source_mime: s.mime || null, source_size: s.file ? s.file.size : null, source_pages: maxPage ? Math.min(Math.max(maxPage, 1), 200) : null,
        engine: ENGINE_AI, languages: 'auto', mean_confidence: res.mean_confidence == null ? null : Math.min(100, Math.max(0, Number(res.mean_confidence))),
        raw_text: String(res.raw_text || '').slice(0, 200000), extracted_fields: res.extracted_fields && typeof res.extracted_fields === 'object' ? res.extracted_fields : (s.orig || {}),
        qr_payload: null, line_items: (res.line_items || []).map(function (x) { return Object.assign({}, x); }), ai_usage_id: res.usage_id
      };
      // an ai-doc-v3 reading (the packing list) is saved with its detail, as the batch reader does
      if (res.ai_detail && typeof res.ai_detail === 'object') row.ai_detail = res.ai_detail;
      if (txId && !attach) row.transaction_id = txId;
      else if (S.orgId) row.org_id = S.orgId;
      return row;
    }
    // the reading's current values (to know whether corrections changed since the last save)
    function fieldsSnap(k) {
      var o = plainFields(S.slots[k]);
      return JSON.stringify(Object.keys(o).sort().map(function (f) { return [f, o[f]]; }));
    }
    // insert the reading; the same file already saved for this org / transaction (document_extractions_dedupe_uidx →
    // MRS_EXTRACTION_DUPLICATE) is reused when it is the same kind of document — one invoice may serve several matches
    function insertOrReuse(k, txId, attach) {
      var row = extractionRow(k, txId, attach);
      var lookup = function (tx) {
        return has('findExtractionBySource')
          ? API.findExtractionBySource({ orgId: S.orgId || undefined, sha256: row.source_sha256, transactionId: tx || null })
          : Promise.resolve({ data: null, error: null });
      };
      var reuse = function (hit) {
        if (!hit) return null;
        if (hit.doc_type !== DOC_TYPE[k]) {
          return { data: null, error: { code: 'MRS_EXTRACTION_DUPLICATE', message: T('m_err_dup_kind', { doc: docName(k), kind: kindName(hit.doc_type) }) } };
        }
        return { data: hit, error: null, reused: true };
      };
      // a reading the single reader already saved (compareReadings): that row is used, never saved a second time
      var ref = savedOf(k);
      if (ref) {
        return Promise.resolve(reuse({ id: ref.id, doc_type: ref.doc_type || DOC_TYPE[k], transaction_id: ref.transaction_id || null,
          document_id: ref.document_id || null, stored: true }));
      }
      // a v3 answer that is a reading already saved (reused:true): that extraction is used, never saved a second time
      var res = S.slots[k].res || {};
      if (res.reused && UUID_RE.test(String(res.extraction_id || ''))) {
        return Promise.resolve(reuse({ id: res.extraction_id, doc_type: res.kind || res.doc_type, transaction_id: res.transaction_id || null, document_id: null, stored: true }));
      }
      // with "attach", the reading is inserted unlinked and then linked: one already on that transaction is reused first
      var first = attach && txId ? lookup(txId).then(function (f) { return f && !f.error ? reuse(f.data) : null; }) : Promise.resolve(null);
      return first.then(function (got) {
        if (got) return got;
        return API.saveExtraction(row).then(function (r) {
          if (!r.error || r.error.code !== 'MRS_EXTRACTION_DUPLICATE') return r;
          return lookup(row.transaction_id || null).then(function (f) {
            if (f.error) return r;
            return reuse(f.data) || r;
          });
        });
      });
    }
    function slotCorrected(k) {
      var s = S.slots[k];
      return Object.keys(s.fields || {}).some(function (f) { return s.fields[f] && s.fields[f].corrected; });
    }
    function payloadRows() {
      return S.result.rows.map(function (r) {
        var o = { key: r.key, label_ar: r.label_ar, label_en: r.label_en, values: {}, status: r.status, detail_ar: r.detail_ar, detail_en: r.detail_en,
          critical: !!r.critical, conf: {}, pairs: {} };
        // only the documents / pairs of this mode (the database refuses a declaration key in a two-way match)
        Object.keys(PAIR_DOCS).forEach(function (p) {
          var d = PAIR_DOCS[p];
          if (S.result.documents.indexOf(d[0]) !== -1 && S.result.documents.indexOf(d[1]) !== -1) o.pairs[p] = r.pairs ? (r.pairs[p] || null) : null;
        });
        S.result.documents.forEach(function (k) {
          o.values[k] = r.values[k] === undefined ? null : r.values[k];
          o.conf[k] = r.conf ? (r.conf[k] == null ? null : r.conf[k]) : null;
        });
        if (correctedKeys(r)) o.corrected = true;
        return o;
      });
    }
    // one key per result to save: a retry after a lost answer does not store the match twice
    function idemKey() {
      if (!S.idem) S.idem = API && API.util && API.util.uuid ? API.util.uuid() : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      return S.idem;
    }
    $('ocr-match-save-btn').addEventListener('click', save);
    function save() {
      if (!S.result || S.saving) return;
      if (!(ONLINE && STAFF)) { setSaveMsg('error', T('m_err_access')); return; }
      if (!has('saveExtraction') || !has('saveDocumentMatch')) { setSaveMsg('error', T('m_save_unavailable')); return; }
      var docs = S.result.documents.filter(function (k) { return S.slots[k].res; });
      var block = saveBlock();
      if (block) { renderSaveState(); return; }
      if (docs.indexOf('invoice') === -1 || docs.indexOf('bl') === -1) { setSaveMsg('error', T('m_err_need_two')); return; }
      if (docs.some(function (k) { return !savedOf(k) && !/^[0-9a-f]{64}$/.test(S.slots[k].sha256 || ''); })) { setSaveMsg('error', T('m_err_hash')); return; }
      S.saving = true; renderSaveState();
      setSaveMsg('info', T('m_saving'));
      var txId = $('ocr-match-tx').value || '';
      var attach = !!(txId && $('ocr-match-attach').checked && has('attachExtractionDocument'));
      var notes = [];
      var chain = Promise.resolve();
      docs.forEach(function (k) {
        chain = chain.then(function () {
          var saved = S.saved.extractions[k];
          if (saved) {
            // already saved (earlier save of this result): only push the corrections made since then
            var snap = fieldsSnap(k);
            if (snap === saved.snap || !slotCorrected(k) || !has('reviewExtraction')) return null;
            return API.reviewExtraction(saved.id, { reviewed_fields: plainFields(S.slots[k]) }).then(function (u) {
              if (u.error) notes.push(T('m_note_review_failed', { doc: docName(k), msg: errMsg(u.error) }));
              else saved.snap = snap;
            });
          }
          return insertOrReuse(k, txId, attach).then(function (r) {
            if (r.error) { var e = r.error; e.doc = k; throw e; }
            var reused = !!r.reused;
            S.saved.extractions[k] = { id: r.data.id, row: r.data, reused: reused, snap: slotCorrected(k) ? null : fieldsSnap(k) };
            if (reused) notes.push(T('m_note_reused', { doc: docName(k) }));
            // a reading of the single reader saved here: that reader knows it now (its own save becomes a review)
            else if (S.slots[k].onSaved) { try { S.slots[k].onSaved(r.data); } catch (x) { /* noop */ } }
            renderSaveState();
            var tasks = Promise.resolve();
            if (slotCorrected(k) && has('reviewExtraction')) {
              tasks = tasks.then(function () {
                return API.reviewExtraction(r.data.id, { reviewed_fields: plainFields(S.slots[k]) }).then(function (u) {
                  if (u.error) notes.push(T('m_note_review_failed', { doc: docName(k), msg: errMsg(u.error) }));
                  else S.saved.extractions[k].snap = fieldsSnap(k);
                });
              });
            }
            // a stored v3 reading (reused:true) that is not on a transaction yet: link it to the transaction the user
            // picked, like a reading saved now (without "attach" that row would carry transaction_id)
            if (!attach && txId && reused && r.data.stored && !r.data.transaction_id && has('reviewExtraction')) {
              tasks = tasks.then(function () {
                return API.reviewExtraction(r.data.id, { transaction_id: txId }).then(function (u) {
                  if (u && u.error) notes.push(T('m_note_review_failed', { doc: docName(k), msg: errMsg(u.error) }));
                });
              });
            }
            // a reused reading that is already linked to the transaction / a document keeps its link
            // (a stored v3 reading already on a transaction keeps it too)
            if (attach && S.slots[k].file && !(reused && (r.data.document_id || (r.data.stored && r.data.transaction_id)))) {
              tasks = tasks.then(function () {
                return API.attachExtractionDocument(r.data.id, { file: S.slots[k].file, transactionId: txId, kind: DOC_TYPE[k] }).then(function (a) {
                  if (!a.error) return null;
                  notes.push(T('m_note_attach_failed', { doc: docName(k), msg: errMsg(a.error) }));
                  if (a.data) return null;
                  // still link the transaction the user picked
                  return has('reviewExtraction') ? API.reviewExtraction(r.data.id, { transaction_id: txId }).then(function () {}) : null;
                });
              });
            }
            return tasks;
          });
        });
      });
      chain.then(function () {
        if (S.saved.match && S.saved.match.id) return null;
        return API.saveDocumentMatch({
          orgId: S.orgId || undefined, transactionId: txId || null,
          invoiceExtractionId: S.saved.extractions.invoice.id, blExtractionId: S.saved.extractions.bl.id,
          declarationExtractionId: S.saved.extractions.declaration ? S.saved.extractions.declaration.id : null,
          packingExtractionId: S.saved.extractions.packing ? S.saved.extractions.packing.id : null,
          mode: S.result.mode, engineVersion: S.result.version, overall: S.result.overall, counts: S.result.counts,
          rows: payloadRows(), reviewedRows: reviewedRows(), note: savedNote(), idempotencyKey: idemKey()
        }).then(function (r) {
          if (r.error) throw r.error;
          S.saved.match = { id: r.data && r.data.id, status: (r.data && r.data.status) || 'saved', created_at: r.data && r.data.created_at };
          var prev = S.saved.prevMatch;
          var after = Promise.resolve();
          if (prev && prev !== S.saved.match.id && has('voidDocumentMatch')) {
            after = API.voidDocumentMatch(prev, T('m_void_superseded', { id: String(S.saved.match.id || '').slice(0, 8) })).then(function (v) {
              if (v.error && !(v.error.code === 'MRS_MATCH_VOIDED')) notes.push(T('m_note_prev_void_failed', { id: String(prev).slice(0, 8), msg: errMsg(v.error) }));
              else { S.saved.prevMatch = null; notes.push(T('m_note_prev_voided', { id: String(prev).slice(0, 8) })); }
            });
          }
          return after.then(function () {
            if (!(S.approved && has('reviewDocumentMatch'))) return null;
            return API.reviewDocumentMatch(S.saved.match.id, reviewedRows(), savedNote()).then(function (v) {
              if (v.error) notes.push(T('m_note_review_match_failed', { msg: errMsg(v.error) }));
              else S.saved.match.status = (v.data && v.data.status) || 'reviewed';
            });
          });
        });
      }).then(function () {
        var ids = S.result.documents.filter(function (k) { return S.saved.extractions[k]; })
          .map(function (k) { return docName(k) + ': ' + String(S.saved.extractions[k].id).slice(0, 8); }).join('، ');
        setSaveMsg(notes.length ? 'warning' : 'success', T('m_saved', { id: String(S.saved.match.id || '').slice(0, 8), docs: ids }) + (notes.length ? ' ' + notes.join(' ') : ''));
        toast(T('m_saved_toast'), 'success');
        renderReview();
        loadRecent();
      }).catch(function (e) {
        var where = e && e.doc ? docName(e.doc) + ': ' : '';
        setSaveMsg('error', T('m_save_failed', { msg: where + errMsg(e) }));
        try { $('ocr-match-save-msg').focus(); } catch (x) { /* noop */ }
      }).then(function () { S.saving = false; renderSaveState(); });
    }

    /* transaction picker */
    $('ocr-match-tx-search').addEventListener('click', searchTx);
    $('ocr-match-tx-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchTx(); } });
    function resetTx() {
      var sel = $('ocr-match-tx'); sel.textContent = '';
      var o0 = el('option', null, T('m_tx_none')); o0.value = ''; sel.appendChild(o0);
    }
    function searchTx() {
      if (!API || !STAFF || !has('listTransactions')) return;
      var q = $('ocr-match-tx-q').value.trim(), b = $('ocr-match-tx-search'), sel = $('ocr-match-tx');
      b.disabled = true;
      var orgP = S.orgId ? Promise.resolve(S.orgId) : activeOrg();
      orgP.then(function (oid) { return API.listTransactions({ search: q, limit: 15, orgId: oid || undefined }); }).then(function (r) {
        b.disabled = false;
        resetTx();
        if (r.error) { toast(errMsg(r.error), 'error'); return; }
        (r.data || []).forEach(function (t) {
          var o = el('option', null, [t.ref, t.bl_number, t.declaration_no, t.clients && t.clients.name_ar].filter(Boolean).join(' — '));
          o.value = t.id; sel.appendChild(o);
        });
        if ((r.data || []).length) { sel.selectedIndex = 1; sel.focus(); }
        announce((r.data || []).length ? T('m_tx_found', { n: r.data.length }) : T('m_tx_none_found'));
      }, function () { b.disabled = false; });
    }
    // a B/L number read from the documents is a good first search
    function suggestTxQuery() {
      var q = $('ocr-match-tx-q');
      if (q.value || !S.result) return;
      var r = S.result.rows.filter(function (x) { return x.key === 'bl_number'; })[0];
      var v = r && (r.values.bl || r.values.declaration || r.values.invoice);
      if (v) q.value = String(v).slice(0, 60);
    }

    /* ---------------------------------------------------------------
       Recent saved matches
       --------------------------------------------------------------- */
    $('ocr-match-recent-refresh').addEventListener('click', loadRecent);
    var recentSeq = 0;
    function loadRecent() {
      var block = $('ocr-match-recent-block');
      if (!(ONLINE && STAFF && has('listDocumentMatches'))) { block.hidden = true; return; }
      block.hidden = false;
      var seq = ++recentSeq;
      activeOrg().then(function (oid) { return API.listDocumentMatches({ orgId: oid || undefined, limit: 10 }); }).then(function (r) {
        if (seq !== recentSeq) return;
        var ul = $('ocr-match-recent'); ul.textContent = '';
        if (!r || r.error) {
          var li = el('li'); li.appendChild(el('span', 'text-sm', T('m_recent_failed', { msg: errMsg(r && r.error) }))); ul.appendChild(li);
          $('ocr-match-recent-empty').hidden = true;
          return;
        }
        var rows = Array.isArray(r.data) ? r.data : [];
        rows.forEach(function (m) { ul.appendChild(recentItem(m)); });
        $('ocr-match-recent-empty').hidden = rows.length > 0;
      }, function () { /* keep the old list */ });
    }
    function countsOf(m) {
      var c = m.counts && typeof m.counts === 'object' ? m.counts : {};
      return { match: Number(c.match != null ? c.match : m.match_count) || 0, mismatch: Number(c.mismatch != null ? c.mismatch : m.mismatch_count) || 0,
        partial: Number(c.partial != null ? c.partial : m.partial_count) || 0, missing: Number(c.missing != null ? c.missing : m.missing_count) || 0 };
    }
    function recentItem(m) {
      var li = el('li');
      var ov = ['match', 'review', 'mismatch'].indexOf(m.overall) !== -1 ? m.overall : 'review';
      li.appendChild(el('span', 'ocr-match-chip ' + OVERALL_CLS[ov], T('m_overall_' + ov)));
      var main = el('div', 'ocr-h-main');
      var title = m.transaction_ref ? T('m_recent_tx', { ref: m.transaction_ref }) : T('m_recent_no_tx');
      main.appendChild(el('span', 'ocr-h-name', title));
      var sub = el('div', 'ocr-h-sub');
      sub.appendChild(el('span', null, fmtDate(m.created_at)));
      var md = m.mode === 'three_way' ? T('m_mode_three') : T('m_mode_two');
      sub.appendChild(el('span', null, m.with_packing || m.packing_extraction_id ? T('m_mode_with_packing', { mode: md }) : md));
      var c = countsOf(m);
      sub.appendChild(el('span', 'num', '✓' + c.match + ' ≈' + c.partial + ' ?' + c.missing + ' ✗' + c.mismatch));
      sub.appendChild(el('span', null, m.status === 'reviewed' ? T('m_review_approved') : T('m_review_pending')));
      main.appendChild(sub);
      li.appendChild(main);
      if (has('voidDocumentMatch') && m.id) {
        var tools = el('div', 'ocr-h-tools');
        var vd = el('button', 'btn btn-ghost btn-sm', T('m_void'));
        vd.type = 'button'; vd.setAttribute('aria-label', T('m_void') + ' — ' + title);
        vd.addEventListener('click', function () {
          var reason = window.prompt(T('m_void_reason'), '');
          if (reason == null) return;
          if (!reason.trim()) { toast(T('m_void_reason_required'), 'warning'); return; }
          API.voidDocumentMatch(m.id, reason.trim().slice(0, 500)).then(function (r) {
            if (r.error) { toast(errMsg(r.error), 'error'); return; }
            toast(T('m_voided'), 'info');
            if (S.saved.match && S.saved.match.id === m.id) { S.saved.match = null; S.idem = null; renderSaveState(); renderReview(); }
            if (S.saved.prevMatch === m.id) S.saved.prevMatch = null;
            loadRecent();
          });
        });
        tools.appendChild(vd);
        li.appendChild(tools);
      }
      return li;
    }

    /* ---------------------------------------------------------------
       Exports: JSON, Excel, print, PNG
       --------------------------------------------------------------- */
    function exportObj() {
      var R = S.result;
      var docs = {};
      R.documents.forEach(function (k) {
        var s = S.slots[k];
        docs[k] = { file_name: slotLabel(k) || null, doc_type: DOC_TYPE[k], usage_id: s.res ? s.res.usage_id || null : null,
          mean_confidence: s.res && s.res.mean_confidence != null ? Number(s.res.mean_confidence) : null,
          extraction_id: S.saved.extractions[k] ? S.saved.extractions[k].id : null, fields: plainFields(s) };
      });
      return { app: 'marsa', kind: 'document_match', version: R.version, generated_at: new Date().toISOString(), read_at: S.readAt,
        mode: R.mode, check_mode: R.check_mode || null, with_packing: !!R.with_packing, overall: R.overall, counts: R.counts, documents: docs, rows: payloadRows(), items: R.items,
        reviewed_rows: reviewedRows(), approved: !!S.approved, reviewer: reviewerName() || null, note: noteText() || null,
        match_id: S.saved.match ? S.saved.match.id : null };
    }
    $('ocr-match-json').addEventListener('click', function () {
      if (!S.result) return;
      try { download(new Blob([JSON.stringify(exportObj(), null, 2)], { type: 'application/json' }), 'marsa-match-' + stamp() + '.json'); }
      catch (e) { toast(T('m_export_failed'), 'error'); }
    });
    $('ocr-match-xlsx').addEventListener('click', function () {
      if (!S.result) return;
      if (!X || typeof X.write !== 'function') { toast(T('m_export_failed'), 'error'); return; }
      try {
        var R = S.result, C = cols();
        var rows = [[T('m_col_field')].concat(C.map(docName)).concat([T('m_col_status'), T('m_col_detail'), T('m_critical'), T('m_col_conf'), T('m_col_reviewed'), T('m_corrected')])];
        R.rows.forEach(function (r) {
          var vals = C.map(function (k) { return r.values[k] == null ? '' : r.values[k]; });
          var cv = C.map(function (k) { return r.conf && r.conf[k]; }).filter(function (x) { return x != null; });
          rows.push([L(r, 'label')].concat(vals).concat([T('m_st_' + r.status), L(r, 'detail') || '', r.critical ? '★' : '',
            cv.length ? Math.round(Math.min.apply(null, cv) * 100) : '', S.reviewed[r.key] ? '✓' : '', correctedKeys(r) ? '✓' : '']));
        });
        var sum = [[T('m_sum_item'), T('m_sum_value')],
          [T('m_report_title'), T('m_overall_' + R.overall)],
          [T('m_meta_mode'), modeText(R)],
          [T('mx_check_meta'), R.check_mode ? checkText(R.check_mode) : ''],
          [T('m_meta_date'), fmtDate(S.readAt || new Date().toISOString())],
          [T('m_meta_org'), orgName(S.orgId)]];
        C.forEach(function (k) { sum.push([docName(k), slotLabel(k)]); });
        ['match', 'partial', 'missing', 'mismatch'].forEach(function (st) { sum.push([T('m_st_' + st), R.counts[st]]); });
        sum.push([T('m_reviewer'), reviewerName()]);
        sum.push([T('m_review_state'), S.approved ? T('m_review_approved') : T('m_review_pending')]);
        sum.push([T('m_note_label'), noteText()]);
        sum.push([T('m_engine_version'), R.version]);
        if (S.saved.match && S.saved.match.id) sum.push([T('m_match_id'), S.saved.match.id]);
        download(X.write([{ name: T('m_sheet_rows'), rows: rows }, { name: T('m_sheet_summary'), rows: sum }]), 'marsa-match-' + stamp() + '.xlsx');
      } catch (e) { toast(T('m_export_failed'), 'error'); }
    });
    $('ocr-match-print').addEventListener('click', function () {
      if (!S.result) return;
      document.body.classList.add('ocr-print-match');
      var mq = window.matchMedia ? window.matchMedia('print') : null;
      var timer = null;
      var done = function () {
        document.body.classList.remove('ocr-print-match');
        window.removeEventListener('afterprint', done);
        if (mq && mq.removeListener) mq.removeListener(onMq);
        if (timer) clearTimeout(timer);
      };
      // window.print() does not block on some mobile browsers: the class stays until the print is over
      var onMq = function (e) { if (!e.matches) done(); };
      window.addEventListener('afterprint', done);
      if (mq && mq.addListener) mq.addListener(onMq);
      try { window.print(); } catch (e) { /* noop */ }
      // a long safety net only (a browser without afterprint / print media events)
      timer = setTimeout(done, 'onafterprint' in window ? 120000 : 60000);
    });

    /* PNG: the report drawn on a canvas (RTL aware, wrapped text, coloured chips) */
    $('ocr-match-png').addEventListener('click', function () {
      if (!S.result) return;
      var b = this; b.disabled = true;
      var fontP = document.fonts && document.fonts.load
        ? Promise.all([document.fonts.load('700 18px Cairo'), document.fonts.load('400 15px Cairo')]).catch(function () {}) : Promise.resolve();
      function encode(canvas) {
        return new Promise(function (resolve, reject) {
          if (canvas.toBlob) canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('png')); }, 'image/png');
          else {
            var d = canvas.toDataURL('image/png'), bin = atob(d.split(',')[1]), arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            resolve(new Blob([arr], { type: 'image/png' }));
          }
        });
      }
      fontP.then(function () { return encode(drawReport()); }).catch(function () {
        // the browser could not encode the large canvas (memory): once more at 1×
        return encode(drawReport(1));
      }).then(function (blob) {
        download(blob, 'marsa-match-' + stamp() + '.png');
      }).catch(function () { toast(T('m_export_failed'), 'error'); }).then(function () { b.disabled = false; });
    });
    // maxScale: upper bound of the pixel ratio (a retry after a failed encode passes 1)
    function drawReport(maxScale) {
      var R = S.result, C = cols(), rtl = lang() !== 'en';
      var W = C.length > 3 ? 1600 : 1400, PAD = 40, SCALE = Math.min(maxScale || 2, Math.max(1, window.devicePixelRatio || 1));
      var FONT = 'Cairo, "Segoe UI", Tahoma, Arial, sans-serif';
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      function font(size, weight) { return (weight || 400) + ' ' + size + 'px ' + FONT; }
      function wrap(text, width, f) {
        ctx.font = f;
        var out = [];
        String(text == null ? '' : text).split('\n').forEach(function (para) {
          var words = para.split(/\s+/).filter(Boolean), line = '';
          if (!words.length) { out.push(''); return; }
          words.forEach(function (w) {
            var t = line ? line + ' ' + w : w;
            if (ctx.measureText(t).width <= width || !line) {
              // a single word longer than the column is cut by characters
              if (!line && ctx.measureText(t).width > width) {
                var part = '';
                for (var i = 0; i < w.length; i++) {
                  if (ctx.measureText(part + w[i]).width > width && part) { out.push(part); part = ''; }
                  part += w[i];
                }
                line = part;
              } else line = t;
            } else { out.push(line); line = w; }
          });
          if (line) out.push(line);
        });
        if (out.length <= 12) return out;
        // cut to 12 lines; the last one ends with an ellipsis so the missing text is visible
        var last = out[11], ell = '…';
        while (last && ctx.measureText(last + ell).width > width) last = last.slice(0, -1);
        out = out.slice(0, 11); out.push(last.replace(/\s+$/, '') + ell);
        return out;
      }
      // columns (logical order: field, docs…, status, conf, reviewed) with widths
      var spec = [{ id: 'field', w: 230 }];
      var docW = Math.floor((W - 2 * PAD - 230 - 330 - 80 - 70) / C.length);
      C.forEach(function (k) { spec.push({ id: k, w: docW }); });
      spec.push({ id: 'status', w: 330 }, { id: 'conf', w: 80 }, { id: 'rev', w: 70 });
      // x of each column (from the right in RTL)
      var x = rtl ? W - PAD : PAD;
      spec.forEach(function (c) {
        if (rtl) { c.x1 = x; c.x0 = x - c.w; x -= c.w; } else { c.x0 = x; c.x1 = x + c.w; x += c.w; }
      });
      var CELL_PAD = 10, LH = 22, F_CELL = font(15), F_HEAD = font(15, 700), F_SMALL = font(13);
      function lines(row) {
        var out = {};
        out.field = wrap(L(row, 'label') + (row.critical ? ' ★' : '') + (correctedKeys(row) ? ' (' + T('m_corrected') + ')' : ''), spec[0].w - 2 * CELL_PAD, font(15, 700));
        C.forEach(function (k, i) { var v = row.values[k]; out[k] = wrap(v === undefined ? '—' : (v == null || v === '' ? '—' : v), spec[i + 1].w - 2 * CELL_PAD, F_CELL); });
        var det = L(row, 'detail') || '';
        out.detail = det ? wrap(det, 330 - 2 * CELL_PAD, F_SMALL) : [];
        if (multi(R)) {
          var pp = Object.keys(PAIR_DOCS).filter(function (p) { return row.pairs && row.pairs[p] && (row.pairs[p] !== 'missing' || row.status === 'missing'); })
            .map(function (p) { return T('m_pair_' + p) + ' ' + pairMark(row.pairs[p]); }).join('   ');
          if (pp) out.detail = out.detail.concat(wrap(pp, 330 - 2 * CELL_PAD, F_SMALL));
        }
        var hh = Math.max(out.field.length * LH, 30 + out.detail.length * 20);
        C.forEach(function (k) { hh = Math.max(hh, out[k].length * LH); });
        out.h = Math.ceil(hh + 2 * CELL_PAD + 6);
        return out;
      }
      var L2 = R.rows.map(lines);
      var metaLines = [];
      metaLines.push(T('m_meta_date') + ': ' + fmtDate(S.readAt || new Date().toISOString()));
      if (orgName(S.orgId)) metaLines.push(T('m_meta_org') + ': ' + orgName(S.orgId));
      C.forEach(function (k) { if (slotLabel(k)) metaLines.push(docName(k) + ': ' + slotLabel(k)); });
      metaLines.push(T('m_meta_mode') + ': ' + modeText(R));
      if (R.check_mode) metaLines.push(T('mx_check_meta') + ': ' + checkText(R.check_mode));
      var revLines = [T('m_reviewer') + ': ' + (reviewerName() || '—') + '   ·   ' + T('m_review_state') + ': '
        + (S.approved || (S.saved.match && S.saved.match.status === 'reviewed') ? T('m_review_approved') : T('m_review_pending'))
        + '   ·   ' + T('m_reviewed_n', { n: reviewedRows().length, total: R.rows.length })];
      var noteL = noteText() ? wrap(T('m_note_label') + ': ' + noteText(), W - 2 * PAD, F_CELL) : [];
      var headH = 70 + metaLines.length * 24 + 20;
      var bannerH = 64;
      var tableH = 44 + L2.reduce(function (s, l) { return s + l.h; }, 0);
      var footH = 30 + (revLines.length + noteL.length) * 26 + 50;
      var H = PAD + headH + bannerH + 20 + tableH + footH + PAD;
      // keep the canvas under the iOS Safari limit (16.7 Mpx) and every browser's side limit
      SCALE = Math.min(SCALE, Math.sqrt(16e6 / (W * H)), 16000 / H);
      SCALE = Math.max(0.25, SCALE);
      canvas.width = Math.round(W * SCALE); canvas.height = Math.round(H * SCALE);
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      try { ctx.direction = rtl ? 'rtl' : 'ltr'; } catch (e) { /* older browsers */ }
      ctx.textBaseline = 'top';
      function text(t, xPos, yPos, f, color, align) {
        ctx.font = f; ctx.fillStyle = color || '#0B2545';
        // a Latin-only value keeps its own order ("12,500 KGS", "Co., Ltd.") inside the RTL layout
        try { ctx.direction = /[\u0600-\u06FF]/.test(String(t)) ? 'rtl' : (rtl && !/[A-Za-z0-9]/.test(String(t)) ? 'rtl' : 'ltr'); } catch (e) { /* noop */ }
        ctx.textAlign = align || (rtl ? 'right' : 'left');
        ctx.fillText(String(t), xPos, yPos);
      }
      function start(c) { return rtl ? c.x1 - CELL_PAD : c.x0 + CELL_PAD; }
      function rrect(x0, y0, w, h, r, fill, stroke) {
        ctx.beginPath();
        ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0); ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
        ctx.lineTo(x0 + w, y0 + h - r); ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
        ctx.lineTo(x0 + r, y0 + h); ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
        ctx.lineTo(x0, y0 + r); ctx.quadraticCurveTo(x0, y0, x0 + r, y0); ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
      }
      function chip(label, status, xStart, yPos) {   // xStart = the reading-start edge
        ctx.font = font(14, 700);
        var w = ctx.measureText(label).width + 22, col = COLORS[status] || COLORS.info;
        var x0 = rtl ? xStart - w : xStart;
        rrect(x0, yPos, w, 26, 13, col[1], null);
        text(label, x0 + w / 2, yPos + 3, font(14, 700), col[0], 'center');
        return w;
      }
      // background
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#0B3A6E'; ctx.fillRect(0, 0, W, 8);
      var y = PAD;
      var sx = rtl ? W - PAD : PAD;
      text(T('m_report_title'), sx, y, font(28, 800), '#0B2545');
      text('MARSA · مرسى', rtl ? PAD : W - PAD, y + 8, font(16, 700), '#14A3A8', rtl ? 'left' : 'right');
      y += 54;
      metaLines.forEach(function (m) { text(m, sx, y, font(15), '#475569'); y += 24; });
      y += 20;
      // banner
      var oc = COLORS[R.overall] || COLORS.review;
      rrect(PAD, y, W - 2 * PAD, bannerH, 14, oc[1], null);
      text(T('m_overall_' + R.overall), rtl ? W - PAD - 20 : PAD + 20, y + 16, font(22, 800), oc[0]);
      var cx = rtl ? PAD + 20 : W - PAD - 20;
      ['mismatch', 'missing', 'partial', 'match'].forEach(function (st) {
        var lbl = T('m_st_' + st) + ': ' + R.counts[st];
        ctx.font = font(14, 700);
        var w = ctx.measureText(lbl).width + 22;
        // counts from the far edge inwards
        var x0 = rtl ? cx : cx - w;
        rrect(x0, y + 19, w, 26, 13, '#FFFFFF', null);
        text(lbl, x0 + w / 2, y + 22, font(14, 700), (COLORS[st] || COLORS.info)[0], 'center');
        cx = rtl ? cx + w + 8 : cx - w - 8;
      });
      y += bannerH + 20;
      // table head
      rrect(PAD, y, W - 2 * PAD, 44, 8, '#0B3A6E', null);
      var heads = { field: T('m_col_field'), status: T('m_col_status'), conf: T('m_col_conf'), rev: T('m_col_reviewed_short') };
      C.forEach(function (k) { heads[k] = docName(k); });
      spec.forEach(function (c) { text(heads[c.id], start(c), y + 11, F_HEAD, '#FFFFFF'); });
      y += 44;
      // rows
      R.rows.forEach(function (row, i) {
        var l = L2[i];
        if (i % 2) { ctx.fillStyle = '#F7F9FC'; ctx.fillRect(PAD, y, W - 2 * PAD, l.h); }
        var col = COLORS[row.status] || COLORS.info;
        ctx.fillStyle = col[0]; ctx.fillRect(rtl ? W - PAD - 4 : PAD, y, 4, l.h);
        var ty = y + CELL_PAD;
        l.field.forEach(function (ln, j) { text(ln, start(spec[0]), ty + j * LH, font(15, 700), '#0B2545'); });
        C.forEach(function (k, ci) { l[k].forEach(function (ln, j) { text(ln, start(spec[ci + 1]), ty + j * LH, F_CELL, '#1E293B'); }); });
        var stc = spec[C.length + 1];
        chip(T('m_st_' + row.status), row.status, start(stc), ty - 2);
        l.detail.forEach(function (ln, j) { text(ln, start(stc), ty + 30 + j * 20, F_SMALL, '#475569'); });
        var cv = C.map(function (k) { return row.conf && row.conf[k]; }).filter(function (v) { return v != null; });
        if (cv.length) {
          var mn = Math.min.apply(null, cv);
          text((mn < LOW_CONF ? '⚠ ' : '') + Math.round(mn * 100) + '%', start(spec[C.length + 2]), ty, F_CELL, mn < LOW_CONF ? '#8A5E04' : '#475569');
        }
        if (S.reviewed[row.key]) text('✓', start(spec[C.length + 3]), ty, font(18, 800), '#0D6B44');
        ctx.fillStyle = '#E2E8F0'; ctx.fillRect(PAD, y + l.h - 1, W - 2 * PAD, 1);
        y += l.h;
      });
      // reviewer + note
      y += 30;
      revLines.forEach(function (ln) { text(ln, sx, y, font(15, 700), '#0B2545'); y += 26; });
      noteL.forEach(function (ln) { text(ln, sx, y, F_CELL, '#1E293B'); y += 26; });
      y += 14;
      text(T('m_png_footer', { v: R.version }), sx, y, F_SMALL, '#94A3B8');
      return canvas;
    }

    /* ---------------------------------------------------------------
       Different shipments (UI only; the engine compares whatever it is given)
       A pair of documents clearly belongs to two shipments when
         - both carry a B/L number, the numbers differ (MarsaDocMatch.blEquivalent) and no container is on both, or
         - the consignee / buyer clearly differs (same script, cmpName mismatch, no close word: clearlyOther) and they
           share no B/L, container or invoice number.
       The comparison is still shown: the reviewer decides.
       --------------------------------------------------------------- */
    function fval(k, keys) {
      var fs = S.slots[k].fields || {};
      for (var i = 0; i < keys.length; i++) { var f = fs[keys[i]]; if (f && hasVal(f.value)) return String(f.value); }
      return '';
    }
    // a B/L consigned "to order" (of a bank / the shipper) names no importer: it says nothing about the shipment
    var TO_ORDER_RE = /\bto\s+(?:the\s+)?order\b|\border\s+of\b|لأمر|لامر|تحت\s+الطلب/i;
    // every name of the importer a document prints (consignee, its identity name, buyer, notify party), "to order" left out
    function partiesOf(k) {
      var fs = S.slots[k].fields || {}, out = [];
      ['consignee_name', 'consignee', 'buyer_name', 'notify_party'].forEach(function (key) {
        var f = fs[key], v = f && hasVal(f.value) ? String(f.value) : '';
        if (v && !TO_ORDER_RE.test(v) && out.indexOf(v) === -1) out.push(v);
      });
      return out;
    }
    function shipInfo(k) {
      var ct = fval(k, ['container_numbers']), parties = partiesOf(k);
      return { k: k, bl: fval(k, ['bl_number']), containers: ct ? E.containerSet(ct) : [], party: parties[0] || '', parties: parties,
        invoice: fval(k, ['invoice_number']) };
    }
    // clearly other importers: every name one document gives is clearly another party than every name of the other
    function partiesOther(a, b) {
      if (!a.parties.length || !b.parties.length) return false;
      return a.parties.every(function (x) { return b.parties.every(function (y) { return clearlyOther(x, y); }); });
    }
    function sameScript(a, b) { var ra = /[؀-ۿ]/.test(a), rb = /[؀-ۿ]/.test(b); return ra === rb; }
    // clearly another party: the names differ (cmpName) and no word of one is close to a word of the other
    // (equal, or one a prefix of the other: MANARA / MANARAH) — a spelling variant is not "another shipment"
    function clearlyOther(a, b) {
      if (!sameScript(a, b)) return false;
      var r; try { r = E.cmpName(a, b); } catch (e) { return false; }
      if (!r || r.s !== 'mismatch') return false;
      var words = function (v) { return String(E.normName(v) || '').split(' ').filter(function (w) { return w.length >= 3 && w !== 'al' && w !== 'ال'; }); };
      var wa = words(a), wb = words(b);
      if (!wa.length || !wb.length) return false;
      return !wa.some(function (x) {
        return wb.some(function (y) { return x === y || (Math.min(x.length, y.length) >= 4 && (x.indexOf(y) === 0 || y.indexOf(x) === 0)); });
      });
    }
    function shareAny(a, b) {
      if (a.bl && b.bl && E.blEquivalent(a.bl, b.bl)) return true;
      if (a.containers.some(function (c) { return b.containers.indexOf(c) !== -1; })) return true;
      if (a.invoice && b.invoice) { try { if (E.cmpId(a.invoice, b.invoice).s === 'match') return true; } catch (e) { /* noop */ } }
      return false;
    }
    function shipmentCheck() {
      var R = S.result;
      if (!R) return null;
      var info = R.documents.filter(function (k) { return S.slots[k].res; }).map(shipInfo);
      var hit = false;
      for (var i = 0; i < info.length && !hit; i++) {
        for (var j = i + 1; j < info.length && !hit; j++) {
          var a = info[i], b = info[j];
          var disjoint = !a.containers.some(function (c) { return b.containers.indexOf(c) !== -1; });
          if (a.bl && b.bl && !E.blEquivalent(a.bl, b.bl) && disjoint) hit = true;
          else if (!shareAny(a, b) && partiesOther(a, b)) hit = true;
        }
      }
      return hit ? info : null;
    }
    function shipmentBanner(info) {
      var box = el('div', 'alert alert-warning ocr-mx-ship');
      box.setAttribute('role', 'note');
      var body = el('div', 'ocr-mx-ship-body');
      body.appendChild(el('strong', 'ocr-mx-ship-title', T('mx_ship_title')));
      body.appendChild(el('p', 'ocr-mx-ship-text', T('mx_ship_text')));
      var ul = el('ul', 'ocr-mx-ship-list');
      SHEET_ORDER.forEach(function (k) {
        var x = info.filter(function (y) { return y.k === k; })[0];
        if (!x) return;
        var li = el('li');
        var head = el('span', 'ocr-mx-ship-head');
        head.appendChild(el('span', 'ocr-mx-ship-doc', docName(k)));
        if (slotLabel(k)) { head.appendChild(document.createTextNode(' — ')); head.appendChild(valNode(slotLabel(k), 'ocr-mx-ship-file')); }
        li.appendChild(head);
        var facts = el('span', 'ocr-mx-ship-facts');
        function fact(label, v) {
          var f = el('span', 'ocr-mx-ship-fact');
          f.appendChild(el('span', 'ocr-mx-ship-lbl', label + ' '));
          f.appendChild(v ? valNode(v, 'ocr-mx-ship-val') : el('span', 'ocr-mx-none', T('mx_not_read')));
          facts.appendChild(f);
        }
        fact(T('mx_ship_bl'), x.bl);
        fact(T('mx_ship_ct'), x.containers.join(', '));
        if (x.party) fact(T('mx_ship_party'), x.party);
        li.appendChild(facts);
        ul.appendChild(li);
      });
      body.appendChild(ul);
      box.appendChild(body);
      return box;
    }

    /* ---------------------------------------------------------------
       compareReadings: readings already made by the single reader (ocr.js) → this report, with NO new AI call
       list = [{ slot, label, fields {key: {value, score}}, items, res (the AI answer, or a part of a combined one),
                 fileName, file?, sha256?, part?, saved? (row or getter: a reading the reader saved), onSaved? (row) }]
       The first entry of a slot wins. Needs 2+ slots and the AI section's access (it stays hidden otherwise).
       --------------------------------------------------------------- */
    function compareReadings(list, opts) {
      opts = opts && typeof opts === 'object' ? opts : {};
      if (!(ONLINE && STAFF && AI.enabled) || S.running || S.saving) return false;
      var picked = {}, n = 0;
      (Array.isArray(list) ? list : []).forEach(function (x) {
        if (!x || typeof x !== 'object' || SLOTS.indexOf(x.slot) === -1 || picked[x.slot] || !x.fields || typeof x.fields !== 'object') return;
        picked[x.slot] = x; n++;
      });
      if (n < 2) return false;
      S = fresh();
      clearResult();
      showError('');
      $('ocr-match-note-text').value = '';
      $('ocr-match-tx-q').value = '';
      resetTx();
      SLOTS.forEach(function (k) {
        var x = picked[k];
        if (!x) return;
        var s = S.slots[k];
        var res = x.res && typeof x.res === 'object' ? x.res : { fields: [] };
        var file = x.file && typeof x.file === 'object' && typeof x.file.name === 'string' ? x.file : null;
        var orig = {}, fields = {};
        (Array.isArray(res.fields) ? res.fields : []).forEach(function (f) {
          if (f && typeof f.name === 'string' && typeof f.value === 'string' && /^[a-z_]{2,40}$/.test(f.name) && !(f.name in orig)) orig[f.name] = f.value;
        });
        Object.keys(x.fields).forEach(function (key) {
          var f = x.fields[key];
          if (!/^[a-z_]{2,40}$/.test(key) || !f || typeof f.value !== 'string' || !f.value) return;
          var c = f.score == null ? null : Number(f.score);
          if (c != null && !isFinite(c)) c = null;
          var v = f.value.slice(0, 2000);
          // a value the reviewer changed in the single reader counts as a correction here too
          fields[key] = Object.prototype.hasOwnProperty.call(orig, key) && orig[key] === v ? { value: v, score: c }
            : { value: v, score: 1, corrected: true, origScore: c };
        });
        s.file = file; s.mime = file ? mediaType(file) : null;
        s.sha256 = /^[0-9a-f]{64}$/.test(String(x.sha256 || '')) ? String(x.sha256) : '';
        s.status = 'done'; s.res = res; s.fields = fields; s.orig = orig;
        s.items = Array.isArray(x.items) ? x.items.slice(0, 500) : [];
        s.label = String(x.label || x.fileName || (file && file.name) || docName(k)).slice(0, 300);
        s.fileName = String(x.fileName || (file && file.name) || '').slice(0, 300);
        s.part = !!x.part; s.savedRef = x.saved || null; s.onSaved = typeof x.onSaved === 'function' ? x.onSaved : null; s.bridged = true;
      });
      S.bridge = { notes: (Array.isArray(opts.notes) ? opts.notes : []).filter(function (t) { return typeof t === 'string' && t; }).slice(0, 10)
        .map(function (t) { return t.slice(0, 600); }) };
      S.readAt = typeof opts.readAt === 'string' ? opts.readAt : new Date().toISOString();
      var mine = S;
      S.orgId = typeof opts.orgId === 'string' && opts.orgId ? opts.orgId : shellOrg();
      if (!S.orgId) activeOrg().then(function (o) { if (S === mine && !S.orgId) S.orgId = o || null; });
      SLOTS.forEach(renderSlot);
      syncRun();
      recompute(false);
      announce(T('mx_bridge_loaded', { n: n }));
      revealReport();
      return true;
    }
    function canCompare() { return !!(ONLINE && STAFF && AI.enabled); }

    /* ---------------------------------------------------------------
       Reset
       --------------------------------------------------------------- */
    $('ocr-match-reset').addEventListener('click', function () {
      if (S.running) return;
      S = fresh();
      clearResult();
      showError('');
      $('ocr-match-note-text').value = '';
      $('ocr-match-tx-q').value = '';
      resetTx();
      SLOTS.forEach(renderSlot);
      syncRun();
      renderSaveState();
      syncGate();
      $('ocr-match-file-invoice').focus();
    });

    /* ---------------------------------------------------------------
       Init
       --------------------------------------------------------------- */
    // the first search suggestion once a result exists
    $('ocr-match-tx-q').addEventListener('focus', suggestTxQuery);
    function boot() {
      return initRole().then(function (st) { STAFF = st; return initAi(); });
    }
    boot();
    // org switcher: access and quota follow the active org; a result already read keeps the org it was read in
    window.addEventListener('marsa:orgchange', function () {
      if (!ONLINE) return;
      if (!S.result && !S.running) { S.orgId = null; resetTx(); }
      boot();
    });
    if (ONLINE && API && API.onAuth) {
      API.onAuth(function () { initRole().then(function (st) { if (st !== STAFF) { STAFF = st; initAi(); } }); });
    }
    window.addEventListener('marsa:langchange', function () { SLOTS.forEach(renderSlot); if (S.result) render(); });
    // test hook (no state is exposed beyond the pure engine)
    // compareReadings: the single reader (ocr.js) opens its readings here (no new AI call)
    window.MarsaOcrMatch = { version: E.VERSION, compareReadings: compareReadings, available: canCompare };
    try { window.dispatchEvent(new CustomEvent('marsa:ocrmatchready')); } catch (e) { /* noop */ }
  });
})();
